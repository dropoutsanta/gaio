// Logs go to stderr so stdout stays clean for reports and the MCP stdio transport.
export function log(...args: unknown[]): void {
  process.stderr.write(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ") + "\n");
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function today(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function normalizeDomain(input: string): string {
  let s = input.trim().toLowerCase();
  s = s.replace(/^[a-z]+:\/\//, "");
  s = s.split(/[/?#]/)[0] ?? s;
  s = s.replace(/:\d+$/, "");
  return s.replace(/^www\./, "");
}

export function domainOf(url: string): string {
  try {
    return normalizeDomain(new URL(url).hostname);
  } catch {
    return normalizeDomain(url);
  }
}

// exact = same registrable host, subdomain = docs.example.com for example.com
export function matchDomain(candidate: string, target: string): "exact" | "subdomain" | null {
  const c = normalizeDomain(candidate);
  const t = normalizeDomain(target);
  if (!c || !t) return null;
  if (c === t) return "exact";
  if (c.endsWith("." + t)) return "subdomain";
  return null;
}

export function brandKey(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\.(com|io|ai|co|app|net|org)$/, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function slugify(name: string): string {
  return brandKey(name).replace(/\s+/g, "-") || "brand";
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Whole-word, case-insensitive match of any alias inside text.
export function mentionsAny(text: string, aliases: string[]): boolean {
  return aliases
    .filter((a) => a.trim().length >= 2)
    .some((a) => new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(a.trim())}($|[^\\p{L}\\p{N}])`, "iu").test(text));
}

// Runs `worker` over items with at most `concurrency` in flight. Stops starting new
// items once `shouldStop` returns true; items already running finish.
export async function pool<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
  shouldStop: () => boolean = () => false,
): Promise<void> {
  let next = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (next < items.length && !shouldStop()) {
      const i = next++;
      await worker(items[i]!, i);
    }
  });
  await Promise.all(runners);
}

export function pct(x: number | null | undefined, digits = 0): string {
  if (x === null || x === undefined || Number.isNaN(x)) return "–";
  return `${(x * 100).toFixed(digits)}%`;
}

export function num(x: number | null | undefined, digits = 1): string {
  if (x === null || x === undefined || Number.isNaN(x)) return "–";
  return x.toFixed(digits);
}

export function safeJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
