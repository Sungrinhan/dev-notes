// 서비스 N개를 순서대로 거치는 요청의 평균, p50, p99 지연을 시뮬레이션한다.
// 호출 한 번: 99%는 평균 10ms(표준편차 2ms), 1%는 200ms. --retry: 50ms 넘으면 끊고 한 번 재시도.

function mulberry32(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const random = mulberry32(42);
const REQUESTS = 100_000;
const SLOW_RATE = 0.01;

function gauss(mean: number, sd: number): number {
  const u = 1 - random();
  const v = random();
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function call(): number {
  if (random() < SLOW_RATE) return 200;
  return Math.max(1, gauss(10, 2));
}

function callWithRetry(timeout = 50): [number, number] {
  const first = call();
  if (first <= timeout) return [first, 1];
  return [timeout + call(), 2]; // 기다린 시간 + 재시도 시간
}

function percentile(values: number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length * q) - 1];
}

const round = (x: number, d = 1) => Math.round(x * 10 ** d) / 10 ** d;

function run(n: number, retry: boolean) {
  const totals: number[] = [];
  let slowHit = 0;
  let calls = 0;
  for (let r = 0; r < REQUESTS; r++) {
    let total = 0;
    let hit = false;
    for (let i = 0; i < n; i++) {
      const [t, c] = retry ? callWithRetry() : [call(), 1];
      calls += c;
      hit ||= t >= 50;
      total += t;
    }
    totals.push(total);
    if (hit) slowHit++;
  }
  return {
    services: n,
    mean: round(totals.reduce((a, b) => a + b, 0) / REQUESTS),
    p50: round(percentile(totals, 0.5)),
    p99: round(percentile(totals, 0.99)),
    slowSharePct: round((100 * slowHit) / REQUESTS, 2),
    theoryPct: round(100 * (1 - (1 - SLOW_RATE) ** n), 2),
    callsPerRequest: round(calls / REQUESTS, 3),
  };
}

const retry = process.argv.includes("--retry");
for (const n of [1, 3, 5, 10, 20]) console.log(JSON.stringify(run(n, retry)));
