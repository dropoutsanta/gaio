import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

// The package root is one level above src/ (dev) or dist/ (built).
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Earlier files win: the install's own .env, then the caller's cwd, then ~/.gaio.
dotenv.config({
  path: [path.join(ROOT, ".env"), path.resolve(".env"), path.join(os.homedir(), ".gaio", ".env")],
  quiet: true,
});

export const ALL_ENGINES = [
  "chatgpt",
  "claude",
  "gemini",
  "perplexity",
  "google_ai_overview",
  "google_ai_mode",
] as const;
export type Engine = (typeof ALL_ENGINES)[number];
export const LLM_ENGINES: readonly Engine[] = ["chatgpt", "claude", "gemini", "perplexity"];
export const GOOGLE_ENGINES: readonly Engine[] = ["google_ai_overview", "google_ai_mode"];
// Claude is opt-in: through DataForSEO it is an API call with web search (~$0.10/answer vs <1¢ for the rest).
export const DEFAULT_ENGINES: readonly Engine[] = ALL_ENGINES.filter((e) => e !== "claude");

export const ENGINE_LABELS: Record<Engine, string> = {
  chatgpt: "ChatGPT",
  claude: "Claude",
  gemini: "Gemini",
  perplexity: "Perplexity",
  google_ai_overview: "Google AI Overview",
  google_ai_mode: "Google AI Mode",
};

export function parseEngines(value: string | undefined | null): Engine[] {
  if (!value) return [...DEFAULT_ENGINES];
  const wanted = value
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const unknown = wanted.filter((e) => !(ALL_ENGINES as readonly string[]).includes(e));
  if (unknown.length) {
    throw new Error(`Unknown engine(s): ${unknown.join(", ")}. Valid: ${ALL_ENGINES.join(", ")}`);
  }
  return ALL_ENGINES.filter((e) => wanted.includes(e));
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const config = {
  anthropicKey: process.env.ANTHROPIC_API_KEY ?? "",
  dataforseoLogin: process.env.DATAFORSEO_LOGIN ?? "",
  dataforseoPassword: process.env.DATAFORSEO_PASSWORD ?? "",
  dataforseoConcurrency: int("DATAFORSEO_CONCURRENCY", 25),
  dataforseoClaudeModel: process.env.DATAFORSEO_CLAUDE_MODEL ?? "",
  dataforseoPerplexityModel: process.env.DATAFORSEO_PERPLEXITY_MODEL ?? "",
  promptConcurrency: int("GAIO_PROMPT_CONCURRENCY", 4),
  dataforseoQueue: process.env.DATAFORSEO_QUEUE !== "0", // ChatGPT/Gemini via the cheaper Standard queue
  model: process.env.GAIO_MODEL || "claude-opus-5-5",
  analysisModel: process.env.GAIO_ANALYSIS_MODEL || "claude-haiku-4-5",
  analysisEffort: (process.env.GAIO_ANALYSIS_EFFORT || "low") as "low" | "medium" | "high" | "xhigh" | "max",
  engines: parseEngines(process.env.GAIO_ENGINES),
  country: process.env.GAIO_COUNTRY || "us",
  language: process.env.GAIO_LANGUAGE || "en",
  dbPath: process.env.GAIO_DB || path.join(ROOT, "data", "gaio.db"),
  apiToken: process.env.GAIO_API_TOKEN ?? "",
  port: int("PORT", 8787),
  resendKey: process.env.RESEND_API_KEY ?? "",
  emailFrom: process.env.GAIO_EMAIL_FROM ?? "",
  emailTo: process.env.GAIO_EMAIL_TO ?? "",
};

export function requireKey(which: "anthropic"): string;
export function requireKey(which: "dataforseo"): [string, string];
export function requireKey(which: "anthropic" | "dataforseo"): string | [string, string] {
  const missing = (name: string) => new Error(`${name} is not set. Add it to ${path.join(ROOT, ".env")}.`);
  if (which === "anthropic") {
    if (!config.anthropicKey) throw missing("ANTHROPIC_API_KEY");
    return config.anthropicKey;
  }
  if (!config.dataforseoLogin || !config.dataforseoPassword) throw missing("DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD");
  return [config.dataforseoLogin, config.dataforseoPassword];
}
