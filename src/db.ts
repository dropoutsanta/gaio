import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { config, type Engine } from "./config.js";
import { safeJson } from "./util.js";

export interface Competitor {
  name: string;
  domain: string;
  aliases: string[];
}

export interface BrandProfile {
  one_liner: string;
  description: string;
  category: string;
  products: string[];
  value_props: string[];
  differentiators: string[];
  icp: {
    industries: string[];
    company_sizes: string[];
    buyer_roles: string[];
    pains: string[];
    geographies: string[];
  };
  use_cases: string[];
  pricing_model: string;
}

export interface BrandSettings {
  country: string;
  language: string;
  engines: Engine[];
  email_to?: string;
}

export interface Brand {
  id: number;
  slug: string;
  name: string;
  domain: string;
  url: string;
  aliases: string[];
  profile: BrandProfile;
  competitors: Competitor[];
  settings: BrandSettings;
  created_at: string;
}

export interface Topic {
  id: number;
  brand_id: number;
  name: string;
  description: string;
  weight: number;
}

export interface Prompt {
  id: number;
  brand_id: number;
  topic_id: number | null;
  topic: string | null;
  text: string;
  intent: string;
  branded: boolean;
  active: boolean;
}

export interface Run {
  id: number;
  brand_id: number;
  run_date: string;
  status: "running" | "complete" | "partial" | "failed";
  engines: Engine[];
  prompt_count: number;
  api_calls: number;
  api_cost: number;
  llm_input_tokens: number;
  llm_output_tokens: number;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

export interface Citation {
  position: number;
  url: string;
  title: string;
  domain: string;
}

export interface AnswerRow {
  id: number;
  run_id: number;
  prompt_id: number;
  engine: Engine;
  model: string | null;
  available: boolean;
  response_text: string;
  citations: Citation[];
  cited: boolean;
  citation_position: number | null;
  error: string | null;
  cost: number;
  analyzed: boolean;
  mentioned: boolean | null;
  mention_rank: number | null;
  sentiment: "positive" | "neutral" | "negative" | null;
  sentiment_score: number | null;
  brand_context: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS brands (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  domain TEXT NOT NULL,
  url TEXT NOT NULL,
  aliases TEXT NOT NULL DEFAULT '[]',
  profile TEXT NOT NULL DEFAULT '{}',
  competitors TEXT NOT NULL DEFAULT '[]',
  settings TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS topics (
  id INTEGER PRIMARY KEY,
  brand_id INTEGER NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  weight REAL NOT NULL DEFAULT 1,
  UNIQUE (brand_id, name)
);
CREATE TABLE IF NOT EXISTS prompts (
  id INTEGER PRIMARY KEY,
  brand_id INTEGER NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  topic_id INTEGER REFERENCES topics(id) ON DELETE SET NULL,
  text TEXT NOT NULL,
  intent TEXT NOT NULL DEFAULT 'discovery',
  branded INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (brand_id, text)
);
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY,
  brand_id INTEGER NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  run_date TEXT NOT NULL,
  status TEXT NOT NULL,
  engines TEXT NOT NULL,
  prompt_count INTEGER NOT NULL DEFAULT 0,
  api_calls INTEGER NOT NULL DEFAULT 0,
  api_cost REAL NOT NULL DEFAULT 0,
  llm_input_tokens INTEGER NOT NULL DEFAULT 0,
  llm_output_tokens INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  UNIQUE (brand_id, run_date)
);
CREATE TABLE IF NOT EXISTS answers (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  prompt_id INTEGER NOT NULL REFERENCES prompts(id) ON DELETE CASCADE,
  engine TEXT NOT NULL,
  model TEXT,
  available INTEGER NOT NULL DEFAULT 1,
  response_text TEXT NOT NULL DEFAULT '',
  citations TEXT NOT NULL DEFAULT '[]',
  cited INTEGER NOT NULL DEFAULT 0,
  citation_position INTEGER,
  error TEXT,
  cost REAL NOT NULL DEFAULT 0,
  analyzed INTEGER NOT NULL DEFAULT 0,
  mentioned INTEGER,
  mention_rank INTEGER,
  sentiment TEXT,
  sentiment_score REAL,
  brand_context TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (run_id, prompt_id, engine)
);
CREATE TABLE IF NOT EXISTS mentions (
  id INTEGER PRIMARY KEY,
  answer_id INTEGER NOT NULL REFERENCES answers(id) ON DELETE CASCADE,
  brand_key TEXT NOT NULL,
  name TEXT NOT NULL,
  rank INTEGER,
  sentiment TEXT,
  is_target INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS pending_tasks (
  run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  prompt_id INTEGER NOT NULL REFERENCES prompts(id) ON DELETE CASCADE,
  engine TEXT NOT NULL,
  task_id TEXT NOT NULL,
  cost REAL NOT NULL DEFAULT 0,
  posted_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (run_id, prompt_id, engine)
);
CREATE INDEX IF NOT EXISTS idx_answers_run ON answers (run_id);
CREATE INDEX IF NOT EXISTS idx_mentions_answer ON mentions (answer_id);
CREATE INDEX IF NOT EXISTS idx_mentions_key ON mentions (brand_key);
`;

let instance: Database.Database | null = null;

export function db(): Database.Database {
  if (instance) return instance;
  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
  instance = new Database(config.dbPath);
  instance.pragma("journal_mode = WAL");
  instance.pragma("foreign_keys = ON");
  instance.pragma("busy_timeout = 5000");
  instance.exec(SCHEMA);
  return instance;
}

// ---------- brands ----------

function toBrand(r: any): Brand {
  return {
    id: r.id,
    slug: r.slug,
    name: r.name,
    domain: r.domain,
    url: r.url,
    aliases: safeJson(r.aliases, []),
    profile: safeJson(r.profile, {} as BrandProfile),
    competitors: safeJson(r.competitors, []),
    settings: safeJson(r.settings, {} as BrandSettings),
    created_at: r.created_at,
  };
}

export function listBrands(): Brand[] {
  return db().prepare("SELECT * FROM brands ORDER BY id").all().map(toBrand);
}

export function getBrand(id: number): Brand | null {
  const r = db().prepare("SELECT * FROM brands WHERE id = ?").get(id);
  return r ? toBrand(r) : null;
}

// Accepts an id, slug, domain or name. With no ref, returns the only brand if there is one.
export function resolveBrand(ref?: string | number | null): Brand {
  const brands = listBrands();
  const wanted = ref ?? process.env.GAIO_BRAND;
  if (wanted === undefined || wanted === null || wanted === "") {
    if (brands.length === 1) return brands[0]!;
    if (brands.length === 0) throw new Error("No brands yet. Run `gaio onboard <url>` first.");
    throw new Error(`Several brands are tracked; pass --brand <${brands.map((b) => b.slug).join("|")}>.`);
  }
  const s = String(wanted).toLowerCase().replace(/^www\./, "");
  const found = brands.find(
    (b) => String(b.id) === s || b.slug === s || b.domain === s || b.name.toLowerCase() === s,
  );
  if (!found) throw new Error(`Unknown brand "${wanted}". Known: ${brands.map((b) => b.slug).join(", ") || "none"}.`);
  return found;
}

export function insertBrand(b: Omit<Brand, "id" | "created_at">): Brand {
  const info = db()
    .prepare(
      `INSERT INTO brands (slug, name, domain, url, aliases, profile, competitors, settings)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      b.slug,
      b.name,
      b.domain,
      b.url,
      JSON.stringify(b.aliases),
      JSON.stringify(b.profile),
      JSON.stringify(b.competitors),
      JSON.stringify(b.settings),
    );
  return getBrand(Number(info.lastInsertRowid))!;
}

export function updateBrand(
  id: number,
  patch: Partial<Pick<Brand, "name" | "aliases" | "profile" | "competitors" | "settings">>,
): Brand {
  const current = getBrand(id);
  if (!current) throw new Error(`Brand ${id} not found`);
  const next = { ...current, ...patch };
  db()
    .prepare("UPDATE brands SET name = ?, aliases = ?, profile = ?, competitors = ?, settings = ? WHERE id = ?")
    .run(
      next.name,
      JSON.stringify(next.aliases),
      JSON.stringify(next.profile),
      JSON.stringify(next.competitors),
      JSON.stringify(next.settings),
      id,
    );
  return getBrand(id)!;
}

export function deleteBrand(id: number): void {
  db().prepare("DELETE FROM brands WHERE id = ?").run(id);
}

// ---------- topics & prompts ----------

export function listTopics(brandId: number): Topic[] {
  return db().prepare("SELECT * FROM topics WHERE brand_id = ? ORDER BY id").all(brandId) as Topic[];
}

export function upsertTopic(brandId: number, name: string, description: string, weight: number): Topic {
  db()
    .prepare(
      `INSERT INTO topics (brand_id, name, description, weight) VALUES (?, ?, ?, ?)
       ON CONFLICT (brand_id, name) DO UPDATE SET description = excluded.description, weight = excluded.weight`,
    )
    .run(brandId, name, description, weight);
  return db().prepare("SELECT * FROM topics WHERE brand_id = ? AND name = ?").get(brandId, name) as Topic;
}

function toPrompt(r: any): Prompt {
  return {
    id: r.id,
    brand_id: r.brand_id,
    topic_id: r.topic_id,
    topic: r.topic ?? null,
    text: r.text,
    intent: r.intent,
    branded: !!r.branded,
    active: !!r.active,
  };
}

export function listPrompts(brandId: number, opts: { activeOnly?: boolean } = {}): Prompt[] {
  const where = opts.activeOnly === false ? "" : "AND p.active = 1";
  return db()
    .prepare(
      `SELECT p.*, t.name AS topic FROM prompts p LEFT JOIN topics t ON t.id = p.topic_id
       WHERE p.brand_id = ? ${where} ORDER BY p.id`,
    )
    .all(brandId)
    .map(toPrompt);
}

export function insertPrompt(
  brandId: number,
  p: { text: string; topicId: number | null; intent: string; branded: boolean },
): Prompt | null {
  const info = db()
    .prepare(
      `INSERT INTO prompts (brand_id, topic_id, text, intent, branded) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (brand_id, text) DO UPDATE SET active = 1`,
    )
    .run(brandId, p.topicId, p.text.trim(), p.intent, p.branded ? 1 : 0);
  if (!info.changes) return null;
  const r = db()
    .prepare("SELECT p.*, t.name AS topic FROM prompts p LEFT JOIN topics t ON t.id = p.topic_id WHERE p.brand_id = ? AND p.text = ?")
    .get(brandId, p.text.trim());
  return r ? toPrompt(r) : null;
}

export function setPromptsActive(brandId: number, ids: number[], active: boolean): number {
  const stmt = db().prepare("UPDATE prompts SET active = ? WHERE brand_id = ? AND id = ?");
  let n = 0;
  for (const id of ids) n += stmt.run(active ? 1 : 0, brandId, id).changes;
  return n;
}

// ---------- runs ----------

function toRun(r: any): Run {
  return { ...r, engines: safeJson(r.engines, []) };
}

export function getRun(id: number): Run | null {
  const r = db().prepare("SELECT * FROM runs WHERE id = ?").get(id);
  return r ? toRun(r) : null;
}

export function getRunByDate(brandId: number, date: string): Run | null {
  const r = db().prepare("SELECT * FROM runs WHERE brand_id = ? AND run_date = ?").get(brandId, date);
  return r ? toRun(r) : null;
}

export function listRuns(brandId: number, limit = 60): Run[] {
  return db()
    .prepare("SELECT * FROM runs WHERE brand_id = ? ORDER BY run_date DESC LIMIT ?")
    .all(brandId, limit)
    .map(toRun);
}

// Latest run that produced data, on or before `date` when given.
export function latestRun(brandId: number, date?: string): Run | null {
  const r = date
    ? db()
        .prepare(
          "SELECT * FROM runs WHERE brand_id = ? AND run_date <= ? AND status IN ('complete','partial','running') ORDER BY run_date DESC LIMIT 1",
        )
        .get(brandId, date)
    : db()
        .prepare(
          "SELECT * FROM runs WHERE brand_id = ? AND status IN ('complete','partial','running') ORDER BY run_date DESC LIMIT 1",
        )
        .get(brandId);
  return r ? toRun(r) : null;
}

export function previousRun(brandId: number, beforeDate: string): Run | null {
  const r = db()
    .prepare(
      "SELECT * FROM runs WHERE brand_id = ? AND run_date < ? AND status IN ('complete','partial') ORDER BY run_date DESC LIMIT 1",
    )
    .get(brandId, beforeDate);
  return r ? toRun(r) : null;
}

export function createRun(brandId: number, date: string, engines: Engine[], promptCount: number): Run {
  db()
    .prepare(
      `INSERT INTO runs (brand_id, run_date, status, engines, prompt_count) VALUES (?, ?, 'running', ?, ?)
       ON CONFLICT (brand_id, run_date) DO UPDATE SET status = 'running', engines = excluded.engines,
         prompt_count = excluded.prompt_count, error = NULL, finished_at = NULL, started_at = datetime('now')`,
    )
    .run(brandId, date, JSON.stringify(engines), promptCount);
  return getRunByDate(brandId, date)!;
}

export function resetRun(runId: number): void {
  db().prepare("DELETE FROM answers WHERE run_id = ?").run(runId);
  db().prepare("DELETE FROM pending_tasks WHERE run_id = ?").run(runId);
  db()
    .prepare("UPDATE runs SET api_calls = 0, api_cost = 0, llm_input_tokens = 0, llm_output_tokens = 0 WHERE id = ?")
    .run(runId);
}

export function addRunUsage(runId: number, u: { apiCalls?: number; apiCost?: number; inTokens?: number; outTokens?: number }): void {
  db()
    .prepare(
      `UPDATE runs SET api_calls = api_calls + ?, api_cost = api_cost + ?,
         llm_input_tokens = llm_input_tokens + ?, llm_output_tokens = llm_output_tokens + ? WHERE id = ?`,
    )
    .run(u.apiCalls ?? 0, u.apiCost ?? 0, u.inTokens ?? 0, u.outTokens ?? 0, runId);
}

export function finishRun(runId: number, status: Run["status"], error: string | null = null): void {
  db()
    .prepare("UPDATE runs SET status = ?, error = ?, finished_at = datetime('now') WHERE id = ?")
    .run(status, error, runId);
}

// ---------- answers ----------

function toAnswer(r: any): AnswerRow {
  return {
    ...r,
    available: !!r.available,
    citations: safeJson(r.citations, []),
    cited: !!r.cited,
    analyzed: !!r.analyzed,
    mentioned: r.mentioned === null ? null : !!r.mentioned,
  };
}

export function upsertAnswer(a: {
  runId: number;
  promptId: number;
  engine: Engine;
  model: string | null;
  available: boolean;
  responseText: string;
  citations: Citation[];
  cited: boolean;
  citationPosition: number | null;
  error: string | null;
  cost: number;
}): number {
  db()
    .prepare(
      `INSERT INTO answers (run_id, prompt_id, engine, model, available, response_text, citations, cited, citation_position, error, cost)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (run_id, prompt_id, engine) DO UPDATE SET model = excluded.model, available = excluded.available,
         response_text = excluded.response_text, citations = excluded.citations, cited = excluded.cited,
         citation_position = excluded.citation_position, error = excluded.error, cost = answers.cost + excluded.cost, analyzed = 0,
         mentioned = NULL, mention_rank = NULL, sentiment = NULL, sentiment_score = NULL, brand_context = NULL`,
    )
    .run(
      a.runId,
      a.promptId,
      a.engine,
      a.model,
      a.available ? 1 : 0,
      a.responseText,
      JSON.stringify(a.citations),
      a.cited ? 1 : 0,
      a.citationPosition,
      a.error,
      a.cost,
    );
  const row = db()
    .prepare("SELECT id FROM answers WHERE run_id = ? AND prompt_id = ? AND engine = ?")
    .get(a.runId, a.promptId, a.engine) as { id: number };
  db().prepare("DELETE FROM mentions WHERE answer_id = ?").run(row.id);
  return row.id;
}

export function saveAnalysis(
  answerId: number,
  a: {
    mentioned: boolean;
    rank: number | null;
    sentiment: AnswerRow["sentiment"];
    sentimentScore: number | null;
    context: string;
    brands: { key: string; name: string; rank: number | null; sentiment: string | null; isTarget: boolean }[];
  },
  analyzed = true,
): void {
  const tx = db().transaction(() => {
    db()
      .prepare(
        `UPDATE answers SET analyzed = ?, mentioned = ?, mention_rank = ?, sentiment = ?, sentiment_score = ?, brand_context = ?
         WHERE id = ?`,
      )
      .run(analyzed ? 1 : 0, a.mentioned ? 1 : 0, a.rank, a.sentiment, a.sentimentScore, a.context, answerId);
    db().prepare("DELETE FROM mentions WHERE answer_id = ?").run(answerId);
    const ins = db().prepare(
      "INSERT INTO mentions (answer_id, brand_key, name, rank, sentiment, is_target) VALUES (?, ?, ?, ?, ?, ?)",
    );
    for (const b of a.brands) ins.run(answerId, b.key, b.name, b.rank, b.sentiment, b.isTarget ? 1 : 0);
  });
  tx();
}

export function answersForRun(runId: number): (AnswerRow & { prompt_text: string; branded: boolean; topic: string | null })[] {
  return db()
    .prepare(
      `SELECT a.*, p.text AS prompt_text, p.branded AS branded, t.name AS topic
       FROM answers a JOIN prompts p ON p.id = a.prompt_id LEFT JOIN topics t ON t.id = p.topic_id
       WHERE a.run_id = ? ORDER BY a.prompt_id, a.engine`,
    )
    .all(runId)
    .map((r: any) => ({ ...toAnswer(r), prompt_text: r.prompt_text, branded: !!r.branded, topic: r.topic }));
}

export function mentionsForRun(runId: number): { answer_id: number; brand_key: string; name: string; rank: number | null; sentiment: string | null; is_target: number }[] {
  return db()
    .prepare(
      `SELECT m.* FROM mentions m JOIN answers a ON a.id = m.answer_id WHERE a.run_id = ?`,
    )
    .all(runId) as any[];
}


// Average billed cost per answer for each engine over recent runs (for cost estimates).
export function engineCostHistory(): Record<string, number> {
  const rows = db()
    .prepare("SELECT engine, AVG(cost) AS c FROM answers WHERE cost > 0 AND created_at >= datetime('now', '-30 days') GROUP BY engine")
    .all() as { engine: string; c: number }[];
  return Object.fromEntries(rows.map((r) => [r.engine, r.c]));
}

// Queued DataForSEO tasks, kept so a crashed or interrupted run collects them instead of paying twice.
export function savePendingTask(runId: number, promptId: number, engine: string, taskId: string, cost: number): void {
  db()
    .prepare("INSERT OR REPLACE INTO pending_tasks (run_id, prompt_id, engine, task_id, cost) VALUES (?, ?, ?, ?, ?)")
    .run(runId, promptId, engine, taskId, cost);
}

export function pendingTasks(runId: number): Map<string, { taskId: string; cost: number }> {
  const rows = db()
    .prepare("SELECT prompt_id, engine, task_id, cost FROM pending_tasks WHERE run_id = ? AND posted_at >= datetime('now', '-25 days')")
    .all(runId) as { prompt_id: number; engine: string; task_id: string; cost: number }[];
  return new Map(rows.map((r) => [`${r.prompt_id}:${r.engine}`, { taskId: r.task_id, cost: r.cost }]));
}

export function deletePendingTask(runId: number, promptId: number, engine: string): void {
  db().prepare("DELETE FROM pending_tasks WHERE run_id = ? AND prompt_id = ? AND engine = ?").run(runId, promptId, engine);
}
