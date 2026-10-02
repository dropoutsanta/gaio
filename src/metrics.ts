import { ENGINE_LABELS, type Engine } from "./config.js";
import {
  type AnswerRow,
  type Brand,
  type Run,
  answersForRun,
  latestRun,
  listBrands,
  listRuns,
  mentionsForRun,
  previousRun,
} from "./db.js";
import { brandKey, domainOf, matchDomain } from "./util.js";

type Answer = AnswerRow & { prompt_text: string; branded: boolean; topic: string | null };
type Mention = ReturnType<typeof mentionsForRun>[number];

export interface EngineStats {
  engine: Engine | "all";
  label: string;
  answered: number; // answers with content and no error
  unavailable: number; // engine showed nothing for the prompt (e.g. no AI Overview)
  errors: number;
  visibility: number | null; // share of unbranded answers that mention the brand
  mentionRateAll: number | null; // same, across all prompts incl. branded
  citationRate: number | null; // share of answers citing the brand's domain
  avgCitationPosition: number | null;
  avgRank: number | null; // position among brands named, when mentioned (unbranded)
  top3Rate: number | null; // unbranded answers where the brand is among the first three named
  sentiment: number | null; // 0-100, over answers that mention the brand
  positive: number;
  neutral: number;
  negative: number;
  shareOfVoice: number | null; // brand's share of all brand mentions (unbranded)
}

export interface BrandStat {
  key: string;
  name: string;
  isTarget: boolean;
  known: boolean;
  domain: string | null;
  mentions: number;
  mentionRate: number | null;
  avgRank: number | null;
  sentiment: number | null;
  citationRate: number | null;
  shareOfVoice: number | null;
}

export interface PromptChange {
  promptId: number;
  prompt: string;
  engines: string[];
}

export interface Gap {
  promptId: number;
  prompt: string;
  topic: string | null;
  competitors: string[]; // brands recommended instead, best-ranked first
  missingOn: string[]; // engines that answered without you
}

export interface Report {
  brand: { id: number; slug: string; name: string; domain: string; category: string };
  run: {
    id: number;
    date: string;
    status: Run["status"];
    error: string | null;
    engines: Engine[];
    prompts: number;
    unbrandedPrompts: number;
    apiCost: number;
    llmTokens: { in: number; out: number };
  };
  overall: EngineStats;
  engines: EngineStats[];
  previous: { date: string; overall: EngineStats; engines: EngineStats[] } | null;
  leaderboard: BrandStat[];
  emerging: BrandStat[];
  topDomains: { domain: string; answers: number; share: number; owner: "you" | "competitor" | null }[];
  topics: { topic: string; answered: number; visibility: number | null }[];
  wins: PromptChange[];
  losses: PromptChange[];
  gaps: Gap[];
  peers: { name: string; domain: string; date: string; visibility: number | null; sentiment: number | null; citationRate: number | null }[];
}

const SENTIMENT_POINTS: Record<string, number> = { positive: 100, neutral: 50, negative: 0 };
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const rate = (n: number, d: number) => (d ? n / d : null);
const answered = (a: Answer) => a.available && !a.error;

function engineStats(engine: Engine | "all", answers: Answer[], mentions: Mention[]): EngineStats {
  const ok = answers.filter(answered);
  const unbranded = ok.filter((a) => !a.branded);
  const mentioned = ok.filter((a) => a.mentioned);
  const mentionedUnbranded = unbranded.filter((a) => a.mentioned);
  const cited = ok.filter((a) => a.cited);
  const ids = new Set(unbranded.map((a) => a.id));
  const ubMentions = mentions.filter((m) => ids.has(m.answer_id));
  const sentiments = mentioned.filter((a) => a.sentiment_score !== null).map((a) => ((a.sentiment_score! + 1) / 2) * 100);
  return {
    engine,
    label: engine === "all" ? "All engines" : ENGINE_LABELS[engine],
    answered: ok.length,
    unavailable: answers.filter((a) => !a.available && !a.error).length,
    errors: answers.filter((a) => a.error).length,
    visibility: rate(mentionedUnbranded.length, unbranded.length),
    mentionRateAll: rate(mentioned.length, ok.length),
    citationRate: rate(cited.length, ok.length),
    avgCitationPosition: avg(cited.filter((a) => a.citation_position !== null).map((a) => a.citation_position!)),
    avgRank: avg(mentionedUnbranded.filter((a) => a.mention_rank !== null).map((a) => a.mention_rank!)),
    top3Rate: rate(mentionedUnbranded.filter((a) => a.mention_rank !== null && a.mention_rank <= 3).length, unbranded.length),
    sentiment: avg(sentiments),
    positive: mentioned.filter((a) => a.sentiment === "positive").length,
    neutral: mentioned.filter((a) => a.sentiment === "neutral").length,
    negative: mentioned.filter((a) => a.sentiment === "negative").length,
    shareOfVoice: rate(ubMentions.filter((m) => m.is_target).length, ubMentions.length),
  };
}

function statsForRun(run: Run): { overall: EngineStats; engines: EngineStats[]; answers: Answer[]; mentions: Mention[] } {
  const answers = answersForRun(run.id);
  const mentions = mentionsForRun(run.id);
  const engines = run.engines.map((e) => engineStats(e, answers.filter((a) => a.engine === e), mentions));
  return { overall: engineStats("all", answers, mentions), engines, answers, mentions };
}

export function headline(brandId: number, date?: string): { run: Run; overall: EngineStats } | null {
  const run = latestRun(brandId, date);
  if (!run) return null;
  return { run, overall: statsForRun(run).overall };
}

export function buildReport(brand: Brand, date?: string): Report {
  const run = latestRun(brand.id, date);
  if (!run) throw new Error(`No runs yet for ${brand.name}. Run \`gaio run\` first.`);
  const { overall, engines, answers, mentions } = statsForRun(run);
  const prev = previousRun(brand.id, run.run_date);
  const prevStats = prev ? statsForRun(prev) : null;

  // Brand leaderboard over unbranded answers: who the engines recommend for your prompts.
  const ok = answers.filter(answered);
  const unbranded = ok.filter((a) => !a.branded);
  const ubIds = new Set(unbranded.map((a) => a.id));
  const ubMentions = mentions.filter((m) => ubIds.has(m.answer_id));
  const knownDomains = new Map<string, string | null>([[brandKey(brand.name), brand.domain]]);
  for (const c of brand.competitors) knownDomains.set(brandKey(c.name), c.domain);
  const groups = new Map<string, Mention[]>();
  for (const m of ubMentions) groups.set(m.brand_key, [...(groups.get(m.brand_key) ?? []), m]);
  for (const k of knownDomains.keys()) if (!groups.has(k)) groups.set(k, []);

  const allBrands: BrandStat[] = [...groups.entries()].map(([key, ms]) => {
    const isTarget = key === brandKey(brand.name) || ms.some((m) => m.is_target);
    const domain = knownDomains.get(key) ?? null;
    const name =
      isTarget ? brand.name : (brand.competitors.find((c) => brandKey(c.name) === key)?.name ?? ms[0]?.name ?? key);
    const answerIds = new Set(ms.map((m) => m.answer_id));
    return {
      key,
      name,
      isTarget,
      known: knownDomains.has(key),
      domain,
      mentions: answerIds.size,
      mentionRate: rate(answerIds.size, unbranded.length),
      avgRank: avg(ms.filter((m) => m.rank !== null).map((m) => m.rank!)),
      sentiment: avg(ms.filter((m) => m.sentiment).map((m) => SENTIMENT_POINTS[m.sentiment!] ?? 50)),
      citationRate: domain
        ? rate(unbranded.filter((a) => a.citations.some((c) => matchDomain(c.domain || domainOf(c.url), domain))).length, unbranded.length)
        : null,
      shareOfVoice: rate(ms.length, ubMentions.length),
    };
  });
  const byRate = (a: BrandStat, b: BrandStat) => (b.mentionRate ?? 0) - (a.mentionRate ?? 0) || b.mentions - a.mentions;
  const leaderboard = allBrands.filter((b) => b.known || b.isTarget).sort(byRate);
  const emerging = allBrands.filter((b) => !b.known && !b.isTarget && b.mentions > 0).sort(byRate).slice(0, 8);

  // Domains the engines cite most — the pages shaping AI answers in your market.
  const domainCounts = new Map<string, number>();
  for (const a of ok) {
    for (const d of new Set(a.citations.map((c) => c.domain || domainOf(c.url)).filter(Boolean))) {
      domainCounts.set(d, (domainCounts.get(d) ?? 0) + 1);
    }
  }
  const topDomains = [...domainCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([domain, n]) => ({
      domain,
      answers: n,
      share: n / Math.max(1, ok.length),
      owner: matchDomain(domain, brand.domain)
        ? ("you" as const)
        : brand.competitors.some((c) => matchDomain(domain, c.domain))
          ? ("competitor" as const)
          : null,
    }));

  const topicMap = new Map<string, Answer[]>();
  for (const a of unbranded) topicMap.set(a.topic ?? "Uncategorised", [...(topicMap.get(a.topic ?? "Uncategorised") ?? []), a]);
  const topics = [...topicMap.entries()]
    .map(([topic, xs]) => ({ topic, answered: xs.length, visibility: rate(xs.filter((a) => a.mentioned).length, xs.length) }))
    .sort((a, b) => (b.visibility ?? 0) - (a.visibility ?? 0));

  // Day-over-day: prompts where an engine started or stopped mentioning the brand.
  const wins: PromptChange[] = [];
  const losses: PromptChange[] = [];
  if (prevStats) {
    const before = new Map(prevStats.answers.filter(answered).map((a) => [`${a.prompt_id}:${a.engine}`, !!a.mentioned]));
    const byPrompt = new Map<number, { prompt: string; won: string[]; lost: string[] }>();
    for (const a of ok) {
      const was = before.get(`${a.prompt_id}:${a.engine}`);
      if (was === undefined || was === !!a.mentioned) continue;
      const e = byPrompt.get(a.prompt_id) ?? { prompt: a.prompt_text, won: [], lost: [] };
      (a.mentioned ? e.won : e.lost).push(ENGINE_LABELS[a.engine]);
      byPrompt.set(a.prompt_id, e);
    }
    for (const [promptId, e] of byPrompt) {
      if (e.won.length) wins.push({ promptId, prompt: e.prompt, engines: e.won });
      if (e.lost.length) losses.push({ promptId, prompt: e.prompt, engines: e.lost });
    }
    wins.sort((a, b) => b.engines.length - a.engines.length);
    losses.sort((a, b) => b.engines.length - a.engines.length);
  }

  // Content gaps: unbranded prompts where an engine recommends competitors and not you.
  const mentionsByAnswer = new Map<number, Mention[]>();
  for (const m of ubMentions) mentionsByAnswer.set(m.answer_id, [...(mentionsByAnswer.get(m.answer_id) ?? []), m]);
  const gapMap = new Map<number, Gap>();
  for (const a of unbranded) {
    if (a.mentioned) continue;
    const rivals = (mentionsByAnswer.get(a.id) ?? []).filter((m) => !m.is_target);
    if (!rivals.length) continue;
    const g = gapMap.get(a.prompt_id) ?? { promptId: a.prompt_id, prompt: a.prompt_text, topic: a.topic, competitors: [], missingOn: [] };
    g.missingOn.push(ENGINE_LABELS[a.engine]);
    for (const r of rivals.sort((x, y) => (x.rank ?? 99) - (y.rank ?? 99))) if (!g.competitors.includes(r.name)) g.competitors.push(r.name);
    gapMap.set(a.prompt_id, g);
  }
  const gaps = [...gapMap.values()]
    .sort((a, b) => b.missingOn.length - a.missingOn.length || b.competitors.length - a.competitors.length)
    .slice(0, 15);

  // Other brands tracked on this GAIO instance that compete with this one.
  const rivalDomains = new Set(brand.competitors.map((c) => c.domain));
  const peers = listBrands()
    .filter((b) => b.id !== brand.id && (rivalDomains.has(b.domain) || b.competitors.some((c) => c.domain === brand.domain)))
    .map((b) => {
      const h = headline(b.id, run.run_date);
      return h
        ? { name: b.name, domain: b.domain, date: h.run.run_date, visibility: h.overall.visibility, sentiment: h.overall.sentiment, citationRate: h.overall.citationRate }
        : null;
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  const promptIds = new Set(answers.map((a) => a.prompt_id));
  const unbrandedPromptIds = new Set(answers.filter((a) => !a.branded).map((a) => a.prompt_id));
  return {
    brand: { id: brand.id, slug: brand.slug, name: brand.name, domain: brand.domain, category: brand.profile.category },
    run: {
      id: run.id,
      date: run.run_date,
      status: run.status,
      error: run.error,
      engines: run.engines,
      prompts: promptIds.size,
      unbrandedPrompts: unbrandedPromptIds.size,
      apiCost: run.api_cost,
      llmTokens: { in: run.llm_input_tokens, out: run.llm_output_tokens },
    },
    overall,
    engines,
    previous: prev && prevStats ? { date: prev.run_date, overall: prevStats.overall, engines: prevStats.engines } : null,
    leaderboard,
    emerging,
    topDomains,
    topics,
    wins: wins.slice(0, 10),
    losses: losses.slice(0, 10),
    gaps,
    peers,
  };
}

export interface TrendPoint {
  date: string;
  status: Run["status"];
  overall: EngineStats;
  engines: EngineStats[];
}

export function buildTrend(brand: Brand, days = 30): TrendPoint[] {
  return listRuns(brand.id, days)
    .filter((r) => r.status === "complete" || r.status === "partial")
    .reverse()
    .map((r) => {
      const s = statsForRun(r);
      return { date: r.run_date, status: r.status, overall: s.overall, engines: s.engines };
    });
}

export function answersFor(brand: Brand, opts: { date?: string; engine?: Engine; promptId?: number; mentioned?: boolean }): Answer[] {
  const run = latestRun(brand.id, opts.date);
  if (!run) return [];
  return answersForRun(run.id).filter(
    (a) =>
      (!opts.engine || a.engine === opts.engine) &&
      (opts.promptId === undefined || a.prompt_id === opts.promptId) &&
      (opts.mentioned === undefined || !!a.mentioned === opts.mentioned),
  );
}
