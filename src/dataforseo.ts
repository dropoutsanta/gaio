import { config, requireKey, type Engine } from "./config.js";
import type { Citation } from "./db.js";
import { domainOf, log, matchDomain, sleep } from "./util.js";

const BASE = "https://api.dataforseo.com/v3";

export interface EngineAnswer {
  engine: Engine;
  model: string | null;
  available: boolean; // false when the engine showed nothing for the prompt (e.g. no AI Overview)
  responseText: string;
  citations: Citation[];
  cited: boolean;
  citationPosition: number | null;
  error: string | null;
  cost: number; // USD, as billed by DataForSEO
}

export interface AccountStatus {
  login: string;
  balance: number;
  verified: boolean;
  message: string | null;
}

// Account-level problems: stop the run instead of failing every prompt one by one.
export class ProviderFatalError extends Error {}

const FATAL = new Set([40100, 40104, 40200, 40201, 40203, 40204, 40207, 40210]);
const RETRYABLE = new Set([40101, 40103, 40202, 40209, 50000, 50001, 50301, 50303, 50401]);
const NO_RESULTS = 40102;
const PENDING = new Set([40601, 40602]); // task handed / in queue

// Engines whose scrapers also have a cheaper Standard (task_post → task_get) mode.
export const QUEUED_ENGINES: readonly Engine[] = ["chatgpt", "gemini"];
const QUEUE_ROUTES: Partial<Record<Engine, string>> = {
  chatgpt: "/ai_optimization/chat_gpt/llm_scraper",
  gemini: "/ai_optimization/gemini/llm_scraper",
};

// DataForSEO location codes (Google Ads geo ids) for common markets.
const LOCATION_CODES: Record<string, number> = {
  us: 2840, gb: 2826, uk: 2826, ca: 2124, au: 2036, nz: 2554, ie: 2372, de: 2276, fr: 2250, es: 2724, it: 2380,
  nl: 2528, be: 2056, ch: 2756, at: 2040, se: 2752, no: 2578, dk: 2208, fi: 2246, pl: 2616, pt: 2620, br: 2076,
  mx: 2484, ar: 2032, in: 2356, jp: 2392, sg: 2702, za: 2710, ae: 2784, il: 2376, kr: 2410,
};
export function locationCode(country: string): number {
  return LOCATION_CODES[country.toLowerCase()] ?? 2840;
}

// Which DataForSEO product answers for each engine. Scrapers read the real consumer UI;
// LLM Responses call the vendor API with web search on.
const ROUTES: Record<Engine, string> = {
  chatgpt: "/ai_optimization/chat_gpt/llm_scraper/live/advanced",
  gemini: "/ai_optimization/gemini/llm_scraper/live/advanced",
  claude: "/ai_optimization/claude/llm_responses/live",
  perplexity: "/ai_optimization/perplexity/llm_responses/live",
  google_ai_mode: "/serp/google/ai_mode/live/advanced",
  google_ai_overview: "/serp/google/organic/live/advanced",
};

class Limiter {
  private active = 0;
  private queue: (() => void)[] = [];
  constructor(private concurrency: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    // A finishing call hands its slot straight to the next waiter, so `active` never overshoots.
    if (this.active >= this.concurrency) await new Promise<void>((r) => this.queue.push(r));
    else this.active++;
    try {
      return await fn();
    } finally {
      const next = this.queue.shift();
      if (next) next();
      else this.active--;
    }
  }
}

export class DataForSeoClient {
  private auth: string;
  private limiter = new Limiter(config.dataforseoConcurrency);
  private models = new Map<string, Promise<string>>();

  constructor() {
    const [login, password] = requireKey("dataforseo");
    this.auth = "Basic " + Buffer.from(`${login}:${password}`).toString("base64");
  }

  async status(): Promise<AccountStatus> {
    const task = await this.call("GET", "/appendix/user_data");
    const r = task.result?.[0] ?? {};
    // user_data works on unverified accounts, so probe a data endpoint for 40104.
    const probe = await this.call("GET", "/ai_optimization/perplexity/llm_responses/models", undefined, { raw: true });
    return {
      login: r.login ?? "",
      balance: Number(r.money?.balance ?? 0),
      verified: probe.status_code !== 40104,
      message: probe.status_code === 20000 ? null : `${probe.status_code} ${probe.status_message}`,
    };
  }

  async answer(engine: Engine, p: { prompt: string; domain: string; country: string; language: string }): Promise<EngineAnswer> {
    try {
      const task = await this.task(engine, p);
      if (!task) return empty(engine, 0);
      return withDomainMatch(task, p.domain);
    } catch (err) {
      if (err instanceof ProviderFatalError) throw err;
      return { ...empty(engine, 0), error: (err as Error).message };
    }
  }

  private async payload(engine: Engine, p: { prompt: string; country: string; language: string }): Promise<Record<string, unknown>> {
    const loc = { location_code: locationCode(p.country), language_code: p.language };
    switch (engine) {
      case "chatgpt":
        return { keyword: p.prompt, ...loc, force_web_search: true };
      case "gemini":
        return { keyword: p.prompt, ...loc };
      case "claude":
        return {
          user_prompt: p.prompt.slice(0, 500),
          model_name: await this.model("claude"),
          web_search: true,
          force_web_search: true,
          web_search_country_iso_code: p.country.toUpperCase(),
          max_output_tokens: 2048,
        };
      case "perplexity":
        return {
          user_prompt: p.prompt.slice(0, 500),
          model_name: await this.model("perplexity"),
          web_search_country_iso_code: p.country.toUpperCase(),
          max_output_tokens: 2048,
        };
      case "google_ai_mode":
        return { keyword: p.prompt.slice(0, 700), ...loc };
      case "google_ai_overview":
        return { keyword: p.prompt.slice(0, 700), ...loc, depth: 10, load_async_ai_overview: true };
    }
  }

  private async task(engine: Engine, p: { prompt: string; country: string; language: string }): Promise<EngineAnswer | null> {
    const t = await this.call("POST", ROUTES[engine], [await this.payload(engine, p)]);
    const cost = Number(t.cost ?? 0);
    const result = t.result?.[0];
    if (t.status_code === NO_RESULTS || !result) return empty(engine, cost);
    if (engine === "chatgpt" || engine === "gemini") return parseScraper(engine, result, cost);
    if (engine === "claude" || engine === "perplexity") return parseLlmResponse(engine, result, cost);
    return parseSerpAi(engine, result, cost);
  }

  // Standard (queued) mode for the ChatGPT / Gemini scrapers: much cheaper than Live, results in minutes.
  async enqueue(engine: Engine, p: { prompt: string; country: string; language: string }): Promise<{ taskId: string; cost: number }> {
    const t = await this.call("POST", `${QUEUE_ROUTES[engine]}/task_post`, [{ ...(await this.payload(engine, p)), priority: 1 }]);
    if (!t.id) throw new Error(`DataForSEO did not return a task id (${t.status_code} ${t.status_message})`);
    return { taskId: String(t.id), cost: Number(t.cost ?? 0) };
  }

  // Polls a queued task until it finishes. Never throws for task-level failures.
  async collect(engine: Engine, taskId: string, domain: string, cost: number, maxWaitMs = 60 * 60_000): Promise<EngineAnswer> {
    const deadline = Date.now() + maxWaitMs;
    try {
      for (;;) {
        const t = await this.call("GET", `${QUEUE_ROUTES[engine]}/task_get/advanced/${taskId}`);
        const code = Number(t.status_code);
        if (code === 20000) {
          const r = t.result?.[0];
          return withDomainMatch(r ? parseScraper(engine, r, cost) : empty(engine, cost), domain);
        }
        if (code === NO_RESULTS) return empty(engine, cost);
        if (!PENDING.has(code)) throw new Error(`DataForSEO ${code}: ${t.status_message}`);
        if (Date.now() > deadline) throw new Error(`queued task ${taskId} not ready after ${Math.round(maxWaitMs / 60_000)} min`);
        await sleep(20_000);
      }
    } catch (err) {
      if (err instanceof ProviderFatalError) throw err;
      return { ...empty(engine, cost), error: (err as Error).message };
    }
  }

  // Picks the model DataForSEO serves for an LLM, unless pinned in .env.
  private model(se: "claude" | "perplexity"): Promise<string> {
    const pinned = se === "claude" ? config.dataforseoClaudeModel : config.dataforseoPerplexityModel;
    if (pinned) return Promise.resolve(pinned);
    if (!this.models.has(se)) {
      this.models.set(
        se,
        this.call("GET", `/ai_optimization/${se}/llm_responses/models`).then((t) => {
          const models: any[] = t.result ?? [];
          const names = models.filter((m) => m.web_search_supported !== false).map((m) => String(m.model_name));
          const pick =
            se === "perplexity"
              ? (names.find((n) => n === "sonar-pro") ?? names.find((n) => n === "sonar") ?? names[0])
              : (names.filter((n) => /sonnet/.test(n)).sort().reverse()[0] ?? names.sort().reverse()[0]);
          if (!pick) throw new Error(`DataForSEO returned no ${se} models`);
          log(`  using ${se} model ${pick} (pin with DATAFORSEO_${se.toUpperCase()}_MODEL)`);
          return pick;
        }),
      );
    }
    return this.models.get(se)!;
  }

  // Returns the first task object; throws on transport/account errors, retries transient ones.
  private async call(method: "GET" | "POST", path: string, body?: unknown, opts: { raw?: boolean } = {}): Promise<any> {
    const attempt = async () => {
      for (let i = 1; ; i++) {
        let res: Response;
        try {
          res = await fetch(BASE + path, {
            method,
            headers: { Authorization: this.auth, "Content-Type": "application/json" },
            body: body ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(150_000),
          });
        } catch (err) {
          if (i >= 3) throw new Error(`DataForSEO network error: ${(err as Error).message}`);
          await sleep(2000 * i);
          continue;
        }
        if (res.status === 401) throw new ProviderFatalError("DataForSEO: invalid login or password (401)");
        if (res.status === 402) throw new ProviderFatalError("DataForSEO: payment required — top up your balance (402)");
        const json: any = await res.json().catch(() => ({}));
        if (opts.raw) return json;
        const top = Number(json.status_code ?? res.status);
        const task = json.tasks?.[0];
        const code = Number(task?.status_code ?? top);
        const message = String(task?.status_message ?? json.status_message ?? res.statusText);
        if (FATAL.has(top) || FATAL.has(code)) throw new ProviderFatalError(`DataForSEO ${code}: ${message}`);
        if ((RETRYABLE.has(top) || RETRYABLE.has(code) || res.status >= 500) && i < 4) {
          await sleep((code === 40202 || code === 40209 ? 10_000 : 3000) * i);
          continue;
        }
        if (top !== 20000 && top !== 20100) throw new Error(`DataForSEO ${top}: ${json.status_message}`);
        if (code === 20000 || code === 20100 || code === NO_RESULTS || PENDING.has(code)) return task;
        throw new Error(`DataForSEO ${code}: ${message}`);
      }
    };
    return this.limiter.run(attempt);
  }
}

function empty(engine: Engine, cost: number): EngineAnswer {
  return { engine, model: null, available: false, responseText: "", citations: [], cited: false, citationPosition: null, error: null, cost };
}

function citationsFrom(list: { url?: string; title?: string; domain?: string; source?: string }[]): Citation[] {
  const seen = new Set<string>();
  const out: Citation[] = [];
  for (const s of list) {
    const url = String(s.url ?? "");
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({ position: out.length + 1, url, title: String(s.title ?? s.source ?? ""), domain: String(s.domain || domainOf(url)) });
  }
  return out;
}

// ChatGPT / Gemini scraped from the consumer UI.
export function parseScraper(engine: Engine, r: any, cost: number): EngineAnswer {
  const items: any[] = r.items ?? [];
  const text = String(r.markdown ?? "") || items.map((i) => i.markdown ?? i.original_text ?? i.text ?? "").filter(Boolean).join("\n\n");
  const sources = [...(r.sources ?? []), ...items.flatMap((i) => i.sources ?? [])];
  return { engine, model: r.model ?? null, available: text.trim().length > 0, responseText: text.trim(), citations: citationsFrom(sources), cited: false, citationPosition: null, error: null, cost };
}

// Claude / Perplexity through their APIs (web search on). A message's sections are inline
// fragments of one text; earlier short messages are "let me search…" narration.
export function parseLlmResponse(engine: Engine, r: any, cost: number): EngineAnswer {
  const messages: any[][] = (r.items ?? []).filter((i: any) => i.type === "message").map((i: any) => i.sections ?? []);
  const texts = messages.map((sections) => sections.map((s) => s.text ?? "").join("").trim());
  const body = texts.filter((t, i) => t && (i === texts.length - 1 || t.length >= 200));
  const text = (body.length ? body : texts.filter(Boolean)).join("\n\n").trim();
  const annotations = messages.flat().flatMap((s) => s.annotations ?? []);
  return { engine, model: r.model_name ?? null, available: text.length > 0, responseText: text, citations: citationsFrom(annotations), cited: false, citationPosition: null, error: null, cost };
}

// Google AI Mode / AI Overview: the `ai_overview` item in a SERP result.
export function parseSerpAi(engine: Engine, r: any, cost: number): EngineAnswer {
  const block = (r.items ?? []).find((i: any) => i.type === "ai_overview");
  if (!block) return empty(engine, cost);
  const parts: any[] = block.items ?? [];
  const text = String(block.markdown ?? "") || parts.map((p) => p.markdown ?? p.text ?? "").filter(Boolean).join("\n\n");
  const refs = [...(block.references ?? []), ...parts.flatMap((p) => [...(p.references ?? []), ...(p.links ?? [])])];
  return { engine, model: null, available: text.trim().length > 0, responseText: text.trim(), citations: citationsFrom(refs), cited: false, citationPosition: null, error: null, cost };
}

function withDomainMatch(a: EngineAnswer, domain: string): EngineAnswer {
  const hit = a.citations.find((c) => matchDomain(c.domain || domainOf(c.url), domain));
  return { ...a, cited: !!hit, citationPosition: hit ? hit.position : null };
}
