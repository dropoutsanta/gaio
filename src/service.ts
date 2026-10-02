import { config, type Engine } from "./config.js";
import { type Brand, engineCostHistory, getRunByDate, listBrands, listPrompts } from "./db.js";
import { headline } from "./metrics.js";
import { runTracking, type RunOptions, type RunSummary } from "./runner.js";
import { log, today } from "./util.js";

// Background runs started from the MCP server or REST API, keyed by brand id.
const active = new Map<number, { startedAt: string; promise: Promise<RunSummary> }>();
const finished = new Map<number, { summary?: RunSummary; error?: string; finishedAt: string }>();

export function startBackgroundRun(brand: Brand, opts: RunOptions = {}): { started: boolean; message: string } {
  if (active.has(brand.id)) return { started: false, message: `A run for ${brand.name} is already in progress (started ${active.get(brand.id)!.startedAt}).` };
  const startedAt = new Date().toISOString();
  const promise = runTracking(brand, opts);
  active.set(brand.id, { startedAt, promise });
  promise
    .then((summary) => finished.set(brand.id, { summary, finishedAt: new Date().toISOString() }))
    .catch((err) => {
      log(`background run failed for ${brand.name}: ${(err as Error).message}`);
      finished.set(brand.id, { error: (err as Error).message, finishedAt: new Date().toISOString() });
    })
    .finally(() => active.delete(brand.id));
  return { started: true, message: `Started tracking run for ${brand.name} (${opts.date ?? today()}). It takes roughly ${Math.ceil(listPrompts(brand.id).length / 6)} min for ${listPrompts(brand.id).length} prompts; check progress with run status.` };
}

export function runStatus(brand: Brand, date = today()) {
  const run = getRunByDate(brand.id, date);
  const bg = active.get(brand.id);
  const last = finished.get(brand.id);
  return {
    brand: brand.slug,
    date,
    inProgress: !!bg,
    run: run
      ? { id: run.id, status: run.status, prompts: run.prompt_count, apiCalls: run.api_calls, apiCost: Number(run.api_cost.toFixed(4)), error: run.error, startedAt: run.started_at, finishedAt: run.finished_at }
      : null,
    lastBackgroundResult: last ? { finishedAt: last.finishedAt, error: last.error ?? null, stoppedEarly: last.summary?.stoppedEarly ?? null } : null,
  };
}

// $ per million tokens (input, output) for the models GAIO is likely to run.
const MODEL_PRICES: Record<string, [number, number]> = {
  "claude-opus-5-5": [4, 20],
  "claude-opus-5": [5, 25],
  "claude-sonnet-5-5": [2, 10],
  "claude-sonnet-5": [2, 10],
  "claude-haiku-4-5": [1, 5],
  "claude-fable-5-1": [10, 50],
};

// Rough DataForSEO cost per answer (USD) until real runs give measured averages.
// ChatGPT/Gemini: Standard queue ≈ $0.0012, Live ≈ $0.004.
const DEFAULT_ENGINE_COST: Record<Engine, number> = {
  chatgpt: config.dataforseoQueue ? 0.0012 : 0.004,
  gemini: config.dataforseoQueue ? 0.0012 : 0.004,
  claude: 0.1, // Sonnet + web search pulls ~20-30k input tokens per answer
  perplexity: 0.012,
  google_ai_mode: 0.003,
  google_ai_overview: 0.004,
};

export function costEstimate(prompts: number, engines: Engine[]) {
  const measured = engineCostHistory();
  const perEngine = Object.fromEntries(engines.map((e) => [e, measured[e] ?? DEFAULT_ENGINE_COST[e]])) as Record<Engine, number>;
  const perPrompt = engines.reduce((s, e) => s + perEngine[e], 0);
  const [pin, pout] = MODEL_PRICES[config.analysisModel] ?? [4, 20];
  // ~1.2k tokens of instructions + ~900 per engine answer in; ~250 per engine out (incl. thinking at low effort).
  const claudePerPrompt = ((1200 + 900 * engines.length) * pin + 250 * engines.length * pout) / 1e6;
  const dataDay = perPrompt * prompts;
  const claudeDay = claudePerPrompt * prompts;
  return {
    prompts,
    engines,
    perEngineUsd: Object.fromEntries(Object.entries(perEngine).map(([e, c]) => [e, Number(c.toFixed(4))])),
    basis: Object.keys(measured).length ? "measured averages (last 30 days) where available" : "DataForSEO list-price estimates",
    dataforseoPerDay: round(dataDay),
    claudePerDay: round(claudeDay),
    totalPerDay: round(dataDay + claudeDay),
    totalPerMonth: round((dataDay + claudeDay) * 30),
    apiCallsPerDay: prompts * engines.length,
    analysisModel: config.analysisModel,
  };
}

const round = (x: number) => Math.round(x * 100) / 100;

export function brandSummaries() {
  return listBrands().map((b) => {
    const h = headline(b.id);
    return {
      id: b.id,
      slug: b.slug,
      name: b.name,
      domain: b.domain,
      category: b.profile.category,
      prompts: listPrompts(b.id).length,
      engines: b.settings.engines,
      competitors: b.competitors.map((c) => c.name),
      latest: h
        ? {
            date: h.run.run_date,
            status: h.run.status,
            visibility: h.overall.visibility,
            citationRate: h.overall.citationRate,
            sentiment: h.overall.sentiment,
            shareOfVoice: h.overall.shareOfVoice,
          }
        : null,
    };
  });
}
