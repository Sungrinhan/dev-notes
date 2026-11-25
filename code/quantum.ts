// 온라인 서점의 아키텍처 퀀텀 수를 유니온 파인드로 센다.
// 동기 호출과 공유 DB는 같은 퀀텀으로 묶고, 비동기 메시지는 묶지 않는다.

type Mode = "sync" | "async";
type Call = [from: string, to: string, mode: Mode];

class UnionFind {
  private parent = new Map<string, string>();

  constructor(items: string[]) {
    for (const x of items) this.parent.set(x, x);
  }

  find(x: string): string {
    while (this.parent.get(x) !== x) {
      const grand = this.parent.get(this.parent.get(x)!)!;
      this.parent.set(x, grand); // 경로 압축
      x = grand;
    }
    return x;
  }

  union(a: string, b: string): void {
    this.parent.set(this.find(a), this.find(b));
  }
}

function quanta(services: string[], calls: Call[], databases: Record<string, string[]>): string[][] {
  const uf = new UnionFind(services);
  for (const [from, to, mode] of calls) {
    if (mode === "sync") uf.union(from, to); // 동기 호출만 묶는다
  }
  for (const users of Object.values(databases)) {
    for (const s of users.slice(1)) uf.union(users[0], s); // 같은 DB를 쓰면 묶는다
  }
  const groups = new Map<string, string[]>();
  for (const s of services) {
    const root = uf.find(s);
    groups.set(root, [...(groups.get(root) ?? []), s]);
  }
  return [...groups.values()].map((g) => g.sort()).sort((a, b) => a.join().localeCompare(b.join()));
}

const SERVICES = ["order", "payment", "notification", "inventory", "catalog", "review"];
const CALLS: Call[] = [
  ["order", "payment", "sync"],
  ["order", "notification", "sync"],
  ["order", "inventory", "sync"],
  ["review", "catalog", "async"],
];
const DATABASES = { shop_db: ["inventory", "catalog"], review_db: ["review"] };

function show(title: string, calls: Call[] = CALLS, dbs: Record<string, string[]> = DATABASES) {
  const q = quanta(SERVICES, calls, dbs);
  console.log(`${title}: ${q.length}개 -> ${JSON.stringify(q)}`);
}

const notifyAsync = CALLS.map((c): Call => (c[1] === "notification" ? ["order", "notification", "async"] : c));
const splitDb = { inventory_db: ["inventory"], catalog_db: ["catalog"], review_db: ["review"] };
const reviewSync = CALLS.map((c): Call => (c[0] === "review" ? ["review", "catalog", "sync"] : c));

show("기본 서점");
show("주문->알림을 비동기로", notifyAsync);
show("주문->알림 비동기 + 카탈로그 DB 분리", notifyAsync, splitDb);
show("리뷰->카탈로그를 동기로", reviewSync);
