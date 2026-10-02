import { ENGINE_LABELS } from "./config.js";
import type { BrandStat, EngineStats, Report, TrendPoint } from "./metrics.js";
import { num, pct } from "./util.js";

// ---------- shared helpers ----------

type Better = "up" | "down";

function delta(cur: number | null, prev: number | null | undefined, kind: "pct" | "points" | "rank"): { text: string; dir: -1 | 0 | 1 } | null {
  if (cur === null || prev === null || prev === undefined) return null;
  const d = cur - prev;
  if (kind === "pct") {
    const pp = d * 100;
    if (Math.abs(pp) < 0.5) return { text: "±0 pp", dir: 0 };
    return { text: `${pp > 0 ? "+" : "−"}${Math.abs(pp).toFixed(0)} pp`, dir: pp > 0 ? 1 : -1 };
  }
  if (Math.abs(d) < 0.05) return { text: "±0", dir: 0 };
  return { text: `${d > 0 ? "+" : "−"}${Math.abs(d).toFixed(1)}`, dir: d > 0 ? 1 : -1 };
}

function prevEngine(r: Report, e: EngineStats): EngineStats | undefined {
  if (!r.previous) return undefined;
  return e.engine === "all" ? r.previous.overall : r.previous.engines.find((x) => x.engine === e.engine);
}

// ---------- markdown (for terminals, coding agents, MCP) ----------

export function reportMarkdown(r: Report): string {
  const o = r.overall;
  const po = r.previous?.overall;
  const d = (cur: number | null, prev: number | null | undefined, kind: "pct" | "points" | "rank") => {
    const x = delta(cur, prev, kind);
    return x ? ` (${x.text})` : "";
  };
  const lines: string[] = [];
  lines.push(`# AI visibility — ${r.brand.name} · ${r.run.date}`);
  lines.push("");
  lines.push(
    `${r.run.prompts} prompts (${r.run.unbrandedPrompts} unbranded) × ${r.run.engines.length} engines · run ${r.run.status}` +
      (r.previous ? ` · compared with ${r.previous.date}` : "") +
      (r.run.error ? `\n> ⚠ ${r.run.error}` : ""),
  );
  lines.push("");
  lines.push("## Headline");
  lines.push("");
  lines.push(`- **Visibility (unbranded prompts): ${pct(o.visibility)}**${d(o.visibility, po?.visibility, "pct")} — share of AI answers that mention ${r.brand.name}`);
  lines.push(`- Citation rate: ${pct(o.citationRate)}${d(o.citationRate, po?.citationRate, "pct")} — answers that cite ${r.brand.domain} as a source`);
  lines.push(`- Sentiment: ${num(o.sentiment, 0)}/100${d(o.sentiment, po?.sentiment, "points")} — ${o.positive} positive · ${o.neutral} neutral · ${o.negative} negative`);
  lines.push(`- Share of voice: ${pct(o.shareOfVoice)}${d(o.shareOfVoice, po?.shareOfVoice, "pct")} of all brand mentions in unbranded answers`);
  lines.push(`- Average position when mentioned: #${num(o.avgRank)} · in top 3: ${pct(o.top3Rate)}`);
  lines.push("");
  lines.push("## By engine");
  lines.push("");
  lines.push("| Engine | Visibility | Mentioned (all) | Cited | Avg cite pos | Sentiment | Avg rank | SoV | Answers |");
  lines.push("|---|---|---|---|---|---|---|---|---|");
  for (const e of r.engines) {
    const p = prevEngine(r, e);
    lines.push(
      `| ${e.label} | ${pct(e.visibility)}${d(e.visibility, p?.visibility, "pct")} | ${pct(e.mentionRateAll)} | ${pct(e.citationRate)} | ${num(e.avgCitationPosition)} | ${num(e.sentiment, 0)} | ${num(e.avgRank)} | ${pct(e.shareOfVoice)} | ${e.answered}${e.unavailable ? ` (+${e.unavailable} none)` : ""}${e.errors ? ` (${e.errors} err)` : ""} |`,
    );
  }
  lines.push("");
  lines.push("## You vs competitors (unbranded prompts)");
  lines.push("");
  lines.push("| Brand | Mentioned in | Avg rank | Sentiment | Cited | Share of voice |");
  lines.push("|---|---|---|---|---|---|");
  for (const b of r.leaderboard) {
    lines.push(
      `| ${b.isTarget ? `**${b.name} (you)**` : b.name} | ${pct(b.mentionRate)} | ${num(b.avgRank)} | ${num(b.sentiment, 0)} | ${pct(b.citationRate)} | ${pct(b.shareOfVoice)} |`,
    );
  }
  if (r.emerging.length) {
    lines.push("");
    lines.push(`Other brands the engines recommend: ${r.emerging.map((b) => `${b.name} (${pct(b.mentionRate)})`).join(", ")}`);
  }
  if (r.peers.length) {
    lines.push("");
    lines.push("## Tracked peers on this GAIO instance (their own prompt sets)");
    lines.push("");
    for (const p of r.peers) lines.push(`- ${p.name}: visibility ${pct(p.visibility)}, sentiment ${num(p.sentiment, 0)}, cited ${pct(p.citationRate)} (${p.date})`);
  }
  if (r.gaps.length) {
    lines.push("");
    lines.push("## Biggest gaps — competitors recommended, you are not");
    lines.push("");
    for (const g of r.gaps.slice(0, 10)) {
      lines.push(`- "${g.prompt}" — missing on ${g.missingOn.join(", ")}; they name ${g.competitors.slice(0, 5).join(", ")} (prompt ${g.promptId}${g.topic ? ` · ${g.topic}` : ""})`);
    }
  }
  if (r.wins.length || r.losses.length) {
    lines.push("");
    lines.push(`## Changes since ${r.previous?.date}`);
    lines.push("");
    for (const w of r.wins) lines.push(`- ▲ now mentioned on ${w.engines.join(", ")}: "${w.prompt}"`);
    for (const l of r.losses) lines.push(`- ▼ dropped on ${l.engines.join(", ")}: "${l.prompt}"`);
  }
  if (r.topics.length) {
    lines.push("");
    lines.push("## Visibility by topic");
    lines.push("");
    for (const t of r.topics) lines.push(`- ${t.topic}: ${pct(t.visibility)} (${t.answered} answers)`);
  }
  if (r.topDomains.length) {
    lines.push("");
    lines.push("## Most-cited sources");
    lines.push("");
    for (const s of r.topDomains.slice(0, 10)) {
      lines.push(`- ${s.domain}${s.owner === "you" ? " (you)" : s.owner === "competitor" ? " (competitor)" : ""}: ${s.answers} answers (${pct(s.share)})`);
    }
  }
  lines.push("");
  lines.push(
    `_Cost: DataForSEO $${r.run.apiCost.toFixed(3)} · Claude ${r.run.llmTokens.in.toLocaleString()} in / ${r.run.llmTokens.out.toLocaleString()} out tokens_`,
  );
  return lines.join("\n");
}

export function trendMarkdown(name: string, points: TrendPoint[]): string {
  if (!points.length) return `No completed runs yet for ${name}.`;
  const engines = [...new Set(points.flatMap((p) => p.engines.map((e) => e.engine)))];
  const head = ["Date", "Visibility", "Cited", "Sentiment", "SoV", ...engines.map((e) => ENGINE_LABELS[e as keyof typeof ENGINE_LABELS] ?? e)];
  const rows = points.map((p) => [
    p.date + (p.status === "partial" ? "*" : ""),
    pct(p.overall.visibility),
    pct(p.overall.citationRate),
    num(p.overall.sentiment, 0),
    pct(p.overall.shareOfVoice),
    ...engines.map((e) => pct(p.engines.find((x) => x.engine === e)?.visibility)),
  ]);
  return [
    `# Visibility trend — ${name}`,
    "",
    `| ${head.join(" | ")} |`,
    `|${head.map(() => "---").join("|")}|`,
    ...rows.map((r) => `| ${r.join(" | ")} |`),
    "",
    "Engine columns show visibility on unbranded prompts. * = partial run.",
  ].join("\n");
}

// ---------- HTML (dashboard + email) ----------

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function deltaHtml(cur: number | null, prev: number | null | undefined, kind: "pct" | "points" | "rank", better: Better = "up"): string {
  const x = delta(cur, prev, kind);
  if (!x) return "";
  const good = x.dir === 0 ? null : (x.dir > 0) === (better === "up");
  const icon = x.dir === 0 ? "■" : x.dir > 0 ? "▲" : "▼";
  return `<span class="delta ${good === null ? "flat" : good ? "good" : "bad"}">${icon} ${x.text}</span>`;
}

function sparkline(values: (number | null)[]): string {
  const pts = values.map((v, i) => [i, v] as const).filter((p): p is readonly [number, number] => p[1] !== null);
  if (pts.length < 2) return "";
  const w = 120;
  const h = 28;
  const max = Math.max(...pts.map((p) => p[1]), 0.01);
  const min = Math.min(...pts.map((p) => p[1]), 0);
  const x = (i: number) => (i / (values.length - 1)) * (w - 8) + 4;
  const y = (v: number) => h - 4 - ((v - min) / (max - min || 1)) * (h - 8);
  const d = pts.map(([i, v], k) => `${k ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const [li, lv] = pts[pts.length - 1]!;
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true"><path d="${d}" fill="none" stroke="var(--muted)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/><circle cx="${x(li).toFixed(1)}" cy="${y(lv).toFixed(1)}" r="4" fill="var(--accent)" stroke="var(--surface)" stroke-width="2"/></svg>`;
}

function meter(v: number | null, label: string): string {
  const w = v === null ? 0 : Math.max(0, Math.min(1, v)) * 100;
  return `<div class="meter" role="img" aria-label="${esc(label)}" title="${esc(label)}"><span style="width:${w.toFixed(1)}%"></span></div>`;
}

function barRow(b: BrandStat, max: number): string {
  const w = b.mentionRate === null || max === 0 ? 0 : (b.mentionRate / max) * 100;
  const tip = `${b.name}: mentioned in ${pct(b.mentionRate)} of unbranded answers · avg rank ${num(b.avgRank)} · sentiment ${num(b.sentiment, 0)}`;
  return `<div class="bar-row" title="${esc(tip)}">
    <div class="bar-label">${esc(b.name)}${b.isTarget ? ' <span class="you">you</span>' : ""}</div>
    <div class="bar-track"><div class="bar ${b.isTarget ? "target" : ""}" style="width:calc((100% - 48px) * ${(w / 100).toFixed(3)})"></div><span class="bar-value">${pct(b.mentionRate)}</span></div>
  </div>`;
}

export function reportHtml(r: Report, trend: TrendPoint[] = []): string {
  const o = r.overall;
  const po = r.previous?.overall;
  const series = (f: (s: EngineStats) => number | null) => trend.map((t) => f(t.overall));
  const tiles = [
    { label: "Citation rate", value: pct(o.citationRate), d: deltaHtml(o.citationRate, po?.citationRate, "pct"), spark: sparkline(series((s) => s.citationRate)) },
    { label: "Sentiment", value: `${num(o.sentiment, 0)}<small>/100</small>`, d: deltaHtml(o.sentiment, po?.sentiment, "points"), spark: sparkline(series((s) => s.sentiment)) },
    { label: "Share of voice", value: pct(o.shareOfVoice), d: deltaHtml(o.shareOfVoice, po?.shareOfVoice, "pct"), spark: sparkline(series((s) => s.shareOfVoice)) },
    { label: "Avg position when mentioned", value: o.avgRank === null ? "–" : `#${num(o.avgRank)}`, d: deltaHtml(o.avgRank, po?.avgRank, "rank", "down"), spark: "" },
  ];
  const maxRate = Math.max(...[...r.leaderboard, ...r.emerging].map((b) => b.mentionRate ?? 0), 0);

  const engineRows = r.engines
    .map((e) => {
      const p = prevEngine(r, e);
      return `<tr>
        <th scope="row">${esc(e.label)}</th>
        <td class="meter-cell">${meter(e.visibility, `${e.label} visibility ${pct(e.visibility)}`)}<span class="num">${pct(e.visibility)}</span> ${deltaHtml(e.visibility, p?.visibility, "pct")}</td>
        <td class="num">${pct(e.citationRate)}</td>
        <td class="num">${num(e.sentiment, 0)}</td>
        <td class="num">${num(e.avgRank)}</td>
        <td class="num">${pct(e.shareOfVoice)}</td>
        <td class="num muted">${e.answered}${e.unavailable ? ` <span title="no AI answer shown for these prompts">+${e.unavailable} none</span>` : ""}${e.errors ? ` <span class="err" title="failed — rerun to retry">${e.errors} failed</span>` : ""}</td>
      </tr>`;
    })
    .join("");

  const list = (title: string, items: string[]) =>
    items.length ? `<section class="card"><h2>${title}</h2><ul class="list">${items.join("")}</ul></section>` : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(r.brand.name)} AI visibility</title>
<style>
:root {
  color-scheme: light;
  --page: #f9f9f7; --surface: #fcfcfb; --ink: #0b0b0b; --ink-2: #52514e; --muted: #898781;
  --grid: #e1e0d9; --border: rgba(11,11,11,0.10);
  --accent: #2a78d6; --track: #cde2fb; --other: #898781;
  --good: #006300; --bad: #d03b3b;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;
    --page: #0d0d0d; --surface: #1a1a19; --ink: #ffffff; --ink-2: #c3c2b7; --muted: #898781;
    --grid: #2c2c2a; --border: rgba(255,255,255,0.10);
    --accent: #3987e5; --track: #184f95; --other: #898781;
    --good: #0ca30c; --bad: #e66767;
  }
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --page: #0d0d0d; --surface: #1a1a19; --ink: #ffffff; --ink-2: #c3c2b7; --muted: #898781;
  --grid: #2c2c2a; --border: rgba(255,255,255,0.10);
  --accent: #3987e5; --track: #184f95; --other: #898781;
  --good: #0ca30c; --bad: #e66767;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--page); color: var(--ink); font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 1040px; margin: 0 auto; padding: 24px 16px 48px; }
header h1 { font-size: 22px; margin: 0 0 4px; font-weight: 600; }
header p { margin: 0; color: var(--ink-2); }
.warn { margin-top: 12px; padding: 10px 12px; border: 1px solid var(--border); border-left: 3px solid var(--bad); background: var(--surface); border-radius: 8px; color: var(--ink-2); }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 16px 18px; margin-top: 16px; }
.card h2 { font-size: 15px; margin: 0 0 12px; font-weight: 600; }
.hero { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 2fr); gap: 16px; align-items: stretch; margin-top: 20px; }
.hero-figure .label { color: var(--ink-2); }
.hero-figure .value { font-size: 56px; font-weight: 600; line-height: 1.1; margin: 4px 0; }
.hero-figure p { margin: 6px 0 0; color: var(--ink-2); font-size: 13px; }
.tiles { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.tile { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 12px 14px; }
.tile .label { color: var(--ink-2); font-size: 13px; }
.tile .value { font-size: 26px; font-weight: 600; }
.tile .value small { font-size: 14px; color: var(--ink-2); font-weight: 400; }
.tile .row, .hero-figure .row { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 28px; flex-wrap: wrap; }
.spark { max-width: 45%; height: auto; }
.delta { font-size: 12px; font-weight: 500; white-space: nowrap; }
.delta.good { color: var(--good); } .delta.bad { color: var(--bad); } .delta.flat { color: var(--muted); }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 8px 6px; border-bottom: 1px solid var(--grid); vertical-align: middle; }
thead th { color: var(--ink-2); font-weight: 500; font-size: 12px; }
td.num, th.num { font-variant-numeric: tabular-nums; white-space: nowrap; }
.muted { color: var(--ink-2); } .err { color: var(--bad); }
.meter-cell { min-width: 220px; white-space: nowrap; }
.meter { display: inline-block; width: 110px; height: 8px; border-radius: 4px; background: var(--track); vertical-align: middle; margin-right: 8px; overflow: hidden; }
.meter span { display: block; height: 100%; background: var(--accent); border-radius: 0 4px 4px 0; }
.bar-row { display: grid; grid-template-columns: 180px minmax(0, 1fr); gap: 12px; align-items: center; padding: 4px 0; }
.bar-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.you { font-size: 11px; color: var(--ink-2); border: 1px solid var(--border); border-radius: 999px; padding: 0 6px; margin-left: 4px; }
.bar-track { display: flex; align-items: center; gap: 8px; border-left: 1px solid var(--grid); min-width: 0; }
.bar { height: 12px; background: var(--other); border-radius: 0 4px 4px 0; min-width: 2px; }
.bar.target { background: var(--accent); }
.bar-value { font-size: 12px; color: var(--ink-2); font-variant-numeric: tabular-nums; }
.legend { display: flex; gap: 16px; color: var(--ink-2); font-size: 12px; margin-bottom: 8px; }
.legend i { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 6px; vertical-align: -1px; }
.list { margin: 0; padding-left: 18px; } .list li { margin: 6px 0; }
.list .meta { color: var(--ink-2); font-size: 13px; }
.cols { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.cols .card { margin-top: 0; }
.scroll { overflow-x: auto; }
footer { color: var(--muted); font-size: 12px; margin-top: 24px; }
@media (max-width: 720px) {
  .hero, .cols { grid-template-columns: 1fr; }
  .tiles { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .bar-row { grid-template-columns: 96px minmax(0, 1fr); }
  .meter { width: 72px; }
  .hero-figure .value { font-size: 48px; }
}
</style>
</head>
<body>
<main>
<header>
  <h1>${esc(r.brand.name)} · AI visibility</h1>
  <p>${esc(r.run.date)} · ${r.run.prompts} prompts × ${r.run.engines.length} engines (${r.run.engines.map((e) => ENGINE_LABELS[e]).join(", ")})${r.previous ? ` · vs ${esc(r.previous.date)}` : ""}</p>
  ${r.run.error ? `<div class="warn">⚠ ${esc(r.run.error)}</div>` : ""}
</header>

<section class="hero">
  <div class="card hero-figure" style="margin-top:0">
    <div class="label">Visibility, unbranded prompts</div>
    <div class="value">${pct(o.visibility)}</div>
    <div class="row">${deltaHtml(o.visibility, po?.visibility, "pct")} ${sparkline(series((s) => s.visibility))}</div>
    <p>Share of AI answers that mention ${esc(r.brand.name)} when buyers ask about the category without naming you.</p>
  </div>
  <div class="tiles">
    ${tiles.map((t) => `<div class="tile"><div class="label">${t.label}</div><div class="row"><div class="value">${t.value}</div>${t.spark}</div><div>${t.d}</div></div>`).join("")}
  </div>
</section>

<section class="card">
  <h2>By engine</h2>
  <div class="scroll"><table>
    <thead><tr><th>Engine</th><th>Visibility</th><th class="num">Cited</th><th class="num">Sentiment</th><th class="num">Avg rank</th><th class="num">Share of voice</th><th class="num">Answers</th></tr></thead>
    <tbody>${engineRows}</tbody>
  </table></div>
</section>

<section class="card">
  <h2>Who the engines recommend for your prompts</h2>
  <div class="legend"><span><i style="background:var(--accent)"></i>${esc(r.brand.name)}</span><span><i style="background:var(--other)"></i>Competitors</span></div>
  ${[...r.leaderboard, ...r.emerging].sort((a, b) => (b.mentionRate ?? 0) - (a.mentionRate ?? 0)).slice(0, 14).map((b) => barRow(b, maxRate)).join("")}
  <div class="scroll" style="margin-top:12px"><table>
    <thead><tr><th>Brand</th><th class="num">Mentioned in</th><th class="num">Avg rank</th><th class="num">Sentiment</th><th class="num">Cited</th><th class="num">Share of voice</th></tr></thead>
    <tbody>${r.leaderboard
      .map(
        (b) =>
          `<tr><th scope="row">${esc(b.name)}${b.isTarget ? ' <span class="you">you</span>' : ""}</th><td class="num">${pct(b.mentionRate)}</td><td class="num">${num(b.avgRank)}</td><td class="num">${num(b.sentiment, 0)}</td><td class="num">${pct(b.citationRate)}</td><td class="num">${pct(b.shareOfVoice)}</td></tr>`,
      )
      .join("")}</tbody>
  </table></div>
</section>

${list(
  "Biggest gaps: competitors recommended, you are not",
  r.gaps.slice(0, 10).map((g) => `<li>${esc(g.prompt)}<div class="meta">Missing on ${esc(g.missingOn.join(", "))} · they name ${esc(g.competitors.slice(0, 5).join(", "))}${g.topic ? ` · ${esc(g.topic)}` : ""}</div></li>`),
)}

${
  r.wins.length || r.losses.length
    ? `<div class="cols" style="margin-top:16px">
  ${list("Gained since last run", r.wins.map((w) => `<li>${esc(w.prompt)}<div class="meta">▲ ${esc(w.engines.join(", "))}</div></li>`)) || '<section class="card"><h2>Gained since last run</h2><p class="muted">None</p></section>'}
  ${list("Lost since last run", r.losses.map((l) => `<li>${esc(l.prompt)}<div class="meta">▼ ${esc(l.engines.join(", "))}</div></li>`)) || '<section class="card"><h2>Lost since last run</h2><p class="muted">None</p></section>'}
</div>`
    : ""
}

<div class="cols" style="margin-top:16px">
  <section class="card">
    <h2>Visibility by topic</h2>
    <table><tbody>${r.topics
      .map((t) => `<tr><th scope="row">${esc(t.topic)}</th><td class="meter-cell">${meter(t.visibility, `${t.topic} ${pct(t.visibility)}`)}<span class="num">${pct(t.visibility)}</span></td></tr>`)
      .join("")}</tbody></table>
  </section>
  <section class="card">
    <h2>Most-cited sources</h2>
    <table><tbody>${r.topDomains
      .slice(0, 12)
      .map((s) => `<tr><th scope="row">${esc(s.domain)}${s.owner === "you" ? ' <span class="you">you</span>' : s.owner === "competitor" ? ' <span class="you">competitor</span>' : ""}</th><td class="num">${s.answers} answers</td><td class="num muted">${pct(s.share)}</td></tr>`)
      .join("")}</tbody></table>
  </section>
</div>

${
  r.peers.length
    ? list(
        "Tracked peers on this GAIO instance",
        r.peers.map((p) => `<li>${esc(p.name)}<div class="meta">visibility ${pct(p.visibility)} · sentiment ${num(p.sentiment, 0)} · cited ${pct(p.citationRate)} · ${esc(p.date)} · measured on their own prompt set</div></li>`),
      )
    : ""
}

<footer>DataForSEO $${r.run.apiCost.toFixed(3)} · Claude ${r.run.llmTokens.in.toLocaleString()} in / ${r.run.llmTokens.out.toLocaleString()} out tokens · run ${r.run.status}</footer>
</main>
</body>
</html>`;
}
