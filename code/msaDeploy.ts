// 카탈로그를 다시 배포하는 동안 주문 요청이 어떻게 되는지 실제 프로세스로 확인한다. 외부 라이브러리 없음.
// 배포 모델(무중단 장치가 없는 단일 인스턴스 stop-start): 기존 프로세스에 종료 신호 -> 종료 확인 후 500ms 대기
//   -> 새 프로세스 기동 -> 포트를 연 뒤 1500ms 동안 준비 중(응답을 미룸). 롤링, readiness 검사, 복제본은 없다.
// 부하: 0ms부터 20ms 간격(고정 스케줄)으로 주문 요청 300건, 2000ms에 배포 시작. 클라이언트는 5000ms까지 기다린다.
// 실행: node msaDeploy.ts [반복 횟수]  -> 구성마다 중앙값과 범위, 첫 실행의 실패 원인과 시간대를 출력한다.
import http from "node:http";
import { once } from "node:events";
import { fork, type ChildProcess } from "node:child_process";

const DOWN_MS = 500;
const WARMUP_MS = 1500;
const INTERVAL_MS = 20;
const REQUESTS = 300;
const DEPLOY_AT_MS = 2000;
const CLIENT_TIMEOUT_MS = 5000;
const PRICE = { 1: 15000, 2: 16000 } as const; // 새 버전에서 가격이 바뀐다
const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

function serve(port: number, warmupMs: number, handle: () => Promise<[number, object]>) {
  let readyAt = Infinity;
  const server = http.createServer(async (_req, res) => {
    await sleep(readyAt - Date.now()); // 준비 중이면 응답을 미룬다
    const [status, body] = await handle();
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  });
  server.listen(port, () => {
    readyAt = Date.now() + warmupMs; // 포트를 연 시점부터 준비 시간을 센다
    process.send?.("listening");
  });
}

// 역할 1: 카탈로그 서비스. 상품 하나의 가격을 돌려준다.
function catalog(port: number, version: 1 | 2, warmupMs: number) {
  serve(port, warmupMs, async () => [200, { price: PRICE[version] }]);
}

// 역할 2: 모놀리스. 주문과 가격 조회가 한 프로세스 안의 함수 호출이다.
function monolith(port: number, version: 1 | 2, warmupMs: number) {
  serve(port, warmupMs, async () => [200, { ok: true, price: PRICE[version] }]);
}

// 역할 3: 주문 서비스. 카탈로그를 HTTP로 부른다. timeoutMs가 0이면 서비스 간 타임아웃을 두지 않는다.
function order(port: number, catalogPort: number, timeoutMs: number, remember: boolean) {
  let last: number | undefined; // 마지막으로 받은 가격(만료 시간 없음)
  serve(port, 0, async () => {
    try {
      const signal = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
      const r = await fetch(`http://127.0.0.1:${catalogPort}/price`, { signal });
      const { price } = (await r.json()) as { price: number };
      last = price;
      return [200, { ok: true, price }];
    } catch (e) {
      if (remember && last !== undefined) return [200, { ok: true, price: last, stale: true }];
      const reason = (e as Error).name === "TimeoutError" ? "catalog-timeout" : "catalog-unreachable";
      return [503, { ok: false, reason }];
    }
  });
}

function start(role: string, ...args: (string | number)[]): Promise<ChildProcess> {
  const child = fork(process.argv[1], [role, ...args.map(String)], { stdio: "ignore" as never });
  return new Promise((resolve) => child.once("message", () => resolve(child)));
}

type Result = { at: number; ms: number; ok: boolean; stale: boolean; reason?: string };

async function sendOrder(port: number, t0: number): Promise<Result> {
  const at = performance.now() - t0;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/order`, { signal: AbortSignal.timeout(CLIENT_TIMEOUT_MS) });
    const body = (await r.json()) as { ok: boolean; stale?: boolean; reason?: string };
    return { at, ms: performance.now() - t0 - at, ok: r.ok && body.ok, stale: body.stale === true, reason: body.reason };
  } catch (e) {
    const reason = (e as Error).name === "TimeoutError" ? "client-timeout" : "entry-unreachable";
    return { at, ms: performance.now() - t0 - at, ok: false, stale: false, reason };
  }
}

type Scenario = { name: string; timeoutMs?: number; remember?: boolean; monolith?: boolean };

async function run(s: Scenario, base: number) {
  const [entryPort, catalogPort] = [base, base + 1];
  const role = s.monolith ? "monolith" : "catalog";
  const port = s.monolith ? entryPort : catalogPort;
  let target = await start(role, port, 1, 0); // 배포 대상 프로세스
  const orderProc = s.monolith ? undefined : await start("order", entryPort, catalogPort, s.timeoutMs ?? 0, s.remember ? 1 : 0);
  const t0 = performance.now();
  const phase = { exited: 0, listening: 0 }; // 기존 프로세스가 끝난 시각, 새 프로세스가 포트를 연 시각(ms)
  const deploy = (async () => {
    await sleep(DEPLOY_AT_MS);
    const exited = once(target, "exit");
    target.kill();
    await exited;
    phase.exited = performance.now() - t0;
    await sleep(DOWN_MS);
    target = await start(role, port, 2, WARMUP_MS);
    phase.listening = performance.now() - t0;
  })();
  const pending: Promise<Result>[] = [];
  for (let i = 0; i < REQUESTS; i++) {
    await sleep(t0 + i * INTERVAL_MS - performance.now()); // 밀려도 다음 요청은 원래 시각에 맞춘다
    pending.push(sendOrder(entryPort, t0));
  }
  const results = await Promise.all(pending);
  await deploy;
  target.kill();
  orderProc?.kill();
  return { results, phase };
}

const p99 = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.ceil(s.length * 0.99) - 1] : NaN;
};
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const span = (xs: number[], f: (x: number) => string) =>
  `${f(median(xs))} (${f(Math.min(...xs))}~${f(Math.max(...xs))})`;

function summarize(results: Result[]) {
  return {
    success: results.filter((r) => r.ok).length / results.length,
    p99All: p99(results.map((r) => r.ms)),
    p99Ok: p99(results.filter((r) => r.ok).map((r) => r.ms)),
    stale: results.filter((r) => r.stale).length,
  };
}

function timeline(results: Result[], phase: { exited: number; listening: number }) {
  const window = (xs: Result[]) => (xs.length ? `${Math.round(xs[0].at)}~${Math.round(xs.at(-1)!.at)}ms` : "-");
  const groups = new Map<string, Result[]>();
  for (const r of results) {
    const key = !r.ok ? `실패(${r.reason})` : r.stale ? "마지막 값" : r.ms > 300 ? "성공, 300ms 초과" : "";
    if (key) groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const parts = [...groups].map(([k, xs]) => `${k} ${xs.length}건 ${window(xs)}`);
  const sent = `요청 ${Math.round(results[0].at)}~${Math.round(results.at(-1)!.at)}ms`;
  return `${sent}, 종료 ${Math.round(phase.exited)}ms, 포트 열림 ${Math.round(phase.listening)}ms | ${parts.join(" | ")}`;
}

const SCENARIOS: Scenario[] = [
  { name: "모놀리스", monolith: true },
  { name: "MSA, 서비스 간 타임아웃 없음" },
  { name: "MSA, 타임아웃 300ms", timeoutMs: 300 },
  { name: "MSA, 타임아웃 300ms + 마지막 값", timeoutMs: 300, remember: true },
];

async function main() {
  const repeat = Number(process.argv[2] ?? 1);
  for (const [i, s] of SCENARIOS.entries()) {
    const runs = [];
    for (let k = 0; k < repeat; k++) runs.push(await run(s, 4100 + i * 20 + k * 2));
    const sums = runs.map((r) => summarize(r.results));
    const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
    const ms = (x: number) => `${Math.round(x)}ms`;
    const n = (x: number) => `${x}건`;
    console.log(`${s.name} (${repeat}회): 성공 ${span(sums.map((x) => x.success), pct)}, ` +
      `p99 전체 ${span(sums.map((x) => x.p99All), ms)}, p99 성공 ${span(sums.map((x) => x.p99Ok), ms)}, ` +
      `마지막 값 ${span(sums.map((x) => x.stale), n)}`);
    console.log(`  첫 실행: ${timeline(runs[0].results, runs[0].phase)}`);
  }
}

const [role, ...a] = process.argv.slice(2);
if (role === "catalog") catalog(+a[0], +a[1] as 1 | 2, +a[2]);
else if (role === "monolith") monolith(+a[0], +a[1] as 1 | 2, +a[2]);
else if (role === "order") order(+a[0], +a[1], +a[2], a[3] === "1");
else void main();
