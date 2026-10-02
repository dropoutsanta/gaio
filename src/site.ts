import { log } from "./util.js";

export interface Page {
  url: string;
  title: string;
  description: string;
  text: string;
}

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";

// Paths most likely to describe what the company sells and to whom.
const USEFUL = /(about|company|pricing|plans|product|platform|features|solutions|use-?cases|customers|case-studies|why|compare|vs|alternative|integrations|industries|who-we-serve|services)/i;

export function normalizeUrl(input: string): string {
  const s = input.trim();
  return /^https?:\/\//i.test(s) ? s : `https://${s}`;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style|noscript|svg|iframe|template)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<\/(p|div|section|article|li|h[1-6]|br|tr|header|footer)>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

function meta(html: string, name: string): string {
  const re = new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]*content=["']([^"']*)["']`, "i");
  const re2 = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:name|property)=["']${name}["']`, "i");
  return decodeEntities(html.match(re)?.[1] ?? html.match(re2)?.[1] ?? "").trim();
}

async function fetchPage(url: string, maxChars: number): Promise<{ page: Page; html: string; finalUrl: string } | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml" },
      redirect: "follow",
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok || !(res.headers.get("content-type") ?? "").includes("html")) return null;
    const html = await res.text();
    const title = decodeEntities(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").trim();
    const description = meta(html, "description") || meta(html, "og:description");
    const text = htmlToText(html).slice(0, maxChars);
    return { page: { url: res.url, title, description, text }, html, finalUrl: res.url };
  } catch {
    return null;
  }
}

// Homepage plus up to `maxPages` same-site pages that look like about/pricing/product pages.
export async function crawlSite(url: string, maxPages = 6): Promise<{ finalUrl: string; pages: Page[] }> {
  const start = normalizeUrl(url);
  const home = await fetchPage(start, 12_000);
  if (!home) {
    log(`  could not fetch ${start}; profiling from the domain alone`);
    return { finalUrl: start, pages: [] };
  }
  const origin = new URL(home.finalUrl);
  const seen = new Set<string>([origin.pathname.replace(/\/$/, "") || "/"]);
  const candidates: string[] = [];
  for (const m of home.html.matchAll(/<a[^>]+href=["']([^"'#]+)["']/gi)) {
    try {
      const u = new URL(m[1]!, origin);
      if (u.hostname.replace(/^www\./, "") !== origin.hostname.replace(/^www\./, "")) continue;
      const p = u.pathname.replace(/\/$/, "") || "/";
      if (seen.has(p) || !USEFUL.test(p) || /\.(pdf|png|jpe?g|svg|zip)$/i.test(p) || p.split("/").length > 4) continue;
      seen.add(p);
      candidates.push(`${u.origin}${p}`);
    } catch {
      // ignore malformed hrefs
    }
  }
  const extra = await Promise.all(candidates.slice(0, maxPages).map((u) => fetchPage(u, 6_000)));
  return { finalUrl: home.finalUrl, pages: [home.page, ...extra.filter((x) => x !== null).map((x) => x.page)] };
}
