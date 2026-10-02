import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod";
import { ALL_ENGINES, config, parseEngines, type Engine } from "./config.js";
import { insertPrompt, listPrompts, listTopics, resolveBrand, setPromptsActive, updateBrand, upsertTopic } from "./db.js";
import { answersFor, buildReport, buildTrend } from "./metrics.js";
import { generatePrompts, onboard } from "./onboarding.js";
import { reportMarkdown, trendMarkdown } from "./render.js";
import { DataForSeoClient } from "./dataforseo.js";
import { brandSummaries, costEstimate, runStatus, startBackgroundRun } from "./service.js";
import { mentionsAny } from "./util.js";

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const json = (x: unknown) => text(JSON.stringify(x, null, 2));
const brandArg = z.string().optional().describe("Brand slug, id or domain. Optional when only one brand is tracked.");
const dateArg = z.string().optional().describe("Run date YYYY-MM-DD. Defaults to the latest run.");

function guard<A>(fn: (args: A) => Promise<ReturnType<typeof text>> | ReturnType<typeof text>) {
  return async (args: A) => {
    try {
      return await fn(args);
    } catch (err) {
      return { ...text(`Error: ${(err as Error).message}`), isError: true };
    }
  };
}

export async function startMcpServer(): Promise<void> {
  const server = new McpServer({ name: "gaio", version: "0.1.0" });

  server.registerTool(
    "gaio_brands",
    {
      description: "List tracked brands with their latest AI-visibility headline (visibility, citation rate, sentiment, share of voice).",
      inputSchema: {},
    },
    guard(() => json(brandSummaries())),
  );

  server.registerTool(
    "gaio_report",
    {
      description:
        "Daily AI-visibility report for a brand: visibility on unbranded prompts, citation rate, sentiment, share of voice, per-engine breakdown (ChatGPT, Claude, Gemini, Perplexity, Google AI Overview/AI Mode), competitor leaderboard, gaps where competitors are recommended instead, and day-over-day changes.",
      inputSchema: { brand: brandArg, date: dateArg, format: z.enum(["markdown", "json"]).optional().describe("Default markdown") },
    },
    guard(({ brand, date, format }: { brand?: string; date?: string; format?: "markdown" | "json" }) => {
      const report = buildReport(resolveBrand(brand), date);
      return format === "json" ? json(report) : text(reportMarkdown(report));
    }),
  );

  server.registerTool(
    "gaio_trend",
    {
      description: "Day-by-day trend of visibility, citation rate, sentiment and share of voice, overall and per engine.",
      inputSchema: { brand: brandArg, days: z.number().int().positive().optional().describe("How many recent runs, default 30") },
    },
    guard(({ brand, days }: { brand?: string; days?: number }) => {
      const b = resolveBrand(brand);
      return text(trendMarkdown(b.name, buildTrend(b, days ?? 30)));
    }),
  );

  server.registerTool(
    "gaio_answers",
    {
      description:
        "Raw AI answers behind a report: what each engine actually said for a prompt, with citations and the brand analysis. Filter by engine, prompt id, or whether the brand was mentioned.",
      inputSchema: {
        brand: brandArg,
        date: dateArg,
        engine: z.enum(ALL_ENGINES).optional(),
        prompt_id: z.number().int().optional(),
        mentioned: z.boolean().optional().describe("true = only answers that mention the brand; false = only answers that miss it"),
        limit: z.number().int().positive().optional().describe("Default 10"),
        full_text: z.boolean().optional().describe("Return full answer text instead of the first 600 characters"),
      },
    },
    guard(
      (a: { brand?: string; date?: string; engine?: Engine; prompt_id?: number; mentioned?: boolean; limit?: number; full_text?: boolean }) => {
        const rows = answersFor(resolveBrand(a.brand), { date: a.date, engine: a.engine, promptId: a.prompt_id, mentioned: a.mentioned });
        return json(
          rows
            .filter((r) => r.available && !r.error)
            .slice(0, a.limit ?? 10)
            .map((r) => ({
              prompt_id: r.prompt_id,
              prompt: r.prompt_text,
              engine: r.engine,
              model: r.model,
              mentioned: r.mentioned,
              rank: r.mention_rank,
              sentiment: r.sentiment,
              how_described: r.brand_context,
              cited: r.cited,
              citation_position: r.citation_position,
              citations: r.citations.slice(0, 10).map((c) => c.url),
              answer: a.full_text ? r.response_text : r.response_text.slice(0, 600),
            })),
        );
      },
    ),
  );

  server.registerTool(
    "gaio_prompts",
    {
      description: "List the brand's tracked prompts with ids, topics and whether they are branded.",
      inputSchema: { brand: brandArg, include_inactive: z.boolean().optional() },
    },
    guard(({ brand, include_inactive }: { brand?: string; include_inactive?: boolean }) => {
      const b = resolveBrand(brand);
      return json({
        topics: listTopics(b.id).map((t) => ({ id: t.id, name: t.name, weight: t.weight })),
        prompts: listPrompts(b.id, { activeOnly: !include_inactive }).map((p) => ({ id: p.id, topic: p.topic, intent: p.intent, branded: p.branded, active: p.active, text: p.text })),
      });
    }),
  );

  server.registerTool(
    "gaio_add_prompts",
    {
      description: "Add custom prompts to track for a brand.",
      inputSchema: { brand: brandArg, prompts: z.array(z.string()).min(1), topic: z.string().optional().describe("Topic name; created if new") },
    },
    guard(({ brand, prompts, topic }: { brand?: string; prompts: string[]; topic?: string }) => {
      const b = resolveBrand(brand);
      const t = topic ? upsertTopic(b.id, topic, "", 1) : null;
      const aliases = [b.name, ...b.aliases];
      const added = prompts
        .map((p) => insertPrompt(b.id, { text: p, topicId: t?.id ?? null, intent: mentionsAny(p, aliases) ? "branded" : "discovery", branded: mentionsAny(p, aliases) }))
        .filter(Boolean);
      return text(`Added ${added.length} prompt(s). ${b.name} now tracks ${listPrompts(b.id).length} active prompts.`);
    }),
  );

  server.registerTool(
    "gaio_remove_prompts",
    {
      description: "Stop tracking prompts (they are deactivated, history is kept).",
      inputSchema: { brand: brandArg, ids: z.array(z.number().int()).min(1) },
    },
    guard(({ brand, ids }: { brand?: string; ids: number[] }) => {
      const b = resolveBrand(brand);
      const n = setPromptsActive(b.id, ids, false);
      return text(`Deactivated ${n} prompt(s). ${listPrompts(b.id).length} active prompts remain.`);
    }),
  );

  server.registerTool(
    "gaio_generate_prompts",
    {
      description: "Generate more prompts for a brand from its profile and topics (Claude).",
      inputSchema: { brand: brandArg, count: z.number().int().positive().max(1000) },
    },
    guard(async ({ brand, count }: { brand?: string; count: number }) => {
      const b = resolveBrand(brand);
      const r = await generatePrompts(b, count);
      return text(`Added ${r.added} prompt(s). ${b.name} now tracks ${listPrompts(b.id).length} active prompts.`);
    }),
  );

  server.registerTool(
    "gaio_onboard",
    {
      description:
        "Start tracking a new brand from its website URL: Claude builds the company profile and ICP, picks competitors, defines prompt topics and generates the prompt set. Takes 1–3 minutes.",
      inputSchema: {
        url: z.string(),
        prompts: z.number().int().positive().max(1000).optional().describe("Number of prompts, default 100"),
        topics: z.number().int().positive().max(30).optional().describe("Number of topics, default 8"),
        name: z.string().optional().describe("Brand name if it differs from what the site says"),
        country: z.string().optional(),
        language: z.string().optional(),
        engines: z.string().optional().describe(`Comma-separated subset of ${ALL_ENGINES.join(",")}`),
      },
    },
    guard(async (a: { url: string; prompts?: number; topics?: number; name?: string; country?: string; language?: string; engines?: string }) => {
      const r = await onboard(a.url, {
        prompts: a.prompts ?? 100,
        topics: a.topics,
        name: a.name,
        country: a.country,
        language: a.language,
        engines: a.engines ? parseEngines(a.engines) : undefined,
      });
      return json({
        brand: { slug: r.brand.slug, name: r.brand.name, domain: r.brand.domain, category: r.brand.profile.category },
        icp: r.brand.profile.icp,
        competitors: r.brand.competitors,
        topics: listTopics(r.brand.id).map((t) => t.name),
        prompts: r.prompts,
        next: "Call gaio_run to run the prompts across all engines.",
      });
    }),
  );

  server.registerTool(
    "gaio_run",
    {
      description:
        "Run today's tracking for a brand in the background: every active prompt on every engine via DataForSEO, then Claude scores mentions and sentiment. Re-running the same day only retries what failed. Check progress with gaio_run_status.",
      inputSchema: {
        brand: brandArg,
        limit: z.number().int().positive().optional().describe("Only run the first N prompts (for testing)"),
        engines: z.string().optional().describe(`Comma-separated subset of ${ALL_ENGINES.join(",")}`),
      },
    },
    guard(({ brand, limit, engines }: { brand?: string; limit?: number; engines?: string }) => {
      const b = resolveBrand(brand);
      return text(startBackgroundRun(b, { limit, engines: engines ? parseEngines(engines) : undefined }).message);
    }),
  );

  server.registerTool(
    "gaio_run_status",
    {
      description: "Progress of today's (or a given date's) tracking run.",
      inputSchema: { brand: brandArg, date: z.string().optional() },
    },
    guard(({ brand, date }: { brand?: string; date?: string }) => json(runStatus(resolveBrand(brand), date))),
  );

  server.registerTool(
    "gaio_engines",
    {
      description:
        "Show or change which engines a brand is tracked on. Claude is off by default because through DataForSEO it costs ~$0.10 per answer vs under 1¢ for the others.",
      inputSchema: {
        brand: brandArg,
        add: z.string().optional().describe(`Comma-separated engines to turn on (${ALL_ENGINES.join(",")})`),
        remove: z.string().optional().describe("Comma-separated engines to turn off"),
      },
    },
    guard(({ brand, add, remove }: { brand?: string; add?: string; remove?: string }) => {
      const b = resolveBrand(brand);
      let engines = b.settings.engines;
      if (add) engines = ALL_ENGINES.filter((e) => engines.includes(e) || parseEngines(add).includes(e));
      if (remove) engines = engines.filter((e) => !parseEngines(remove).includes(e));
      if (add || remove) updateBrand(b.id, { settings: { ...b.settings, engines } });
      return json({ brand: b.slug, engines, cost: costEstimate(listPrompts(b.id).length, engines) });
    }),
  );

  server.registerTool(
    "gaio_status",
    {
      description: "Account and cost status: DataForSEO balance and verification, configured models, and the estimated daily cost for each brand.",
      inputSchema: {},
    },
    guard(async () => {
      const s = await new DataForSeoClient().status();
      return json({
        dataforseo: s,
        models: { onboarding: config.model, analysis: config.analysisModel, analysisEffort: config.analysisEffort },
        brands: brandSummaries().map((b) => ({ brand: b.slug, ...costEstimate(b.prompts, b.engines) })),
      });
    }),
  );

  await server.connect(new StdioServerTransport());
}
