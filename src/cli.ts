#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { ALL_ENGINES, config, ENGINE_LABELS, parseEngines, ROOT } from "./config.js";
import { DataForSeoClient } from "./dataforseo.js";
import {
  insertPrompt,
  listBrands,
  listPrompts,
  listTopics,
  resolveBrand,
  setPromptsActive,
  updateBrand,
  upsertTopic,
} from "./db.js";
import { emailConfigured, sendReportEmail } from "./email.js";
import { answersFor, buildReport, buildTrend } from "./metrics.js";
import { generatePrompts, onboard } from "./onboarding.js";
import { reportHtml, reportMarkdown, trendMarkdown } from "./render.js";
import { runTracking } from "./runner.js";
import { brandSummaries, costEstimate } from "./service.js";
import { domainOf, mentionsAny, normalizeDomain, pct, today } from "./util.js";

const program = new Command();
program.name("gaio").description("Track how ChatGPT, Claude, Gemini, Perplexity and Google AI talk about your brand.").version("0.1.0");

const out = (s: string): void => {
  process.stdout.write(s.endsWith("\n") ? s : s + "\n");
};
const asJson = (x: unknown): void => out(JSON.stringify(x, null, 2));

program
  .command("onboard <url>")
  .description("Profile a company from its website (ICP, competitors), define prompt topics and generate prompts")
  .option("-p, --prompts <n>", "number of prompts to generate", "100")
  .option("-t, --topics <n>", "number of prompt topics", "8")
  .option("--name <name>", "brand name, if the site is ambiguous")
  .option("--country <cc>", "2-letter market to ask the engines about", config.country)
  .option("--language <code>", "language of the prompts", config.language)
  .option("--engines <list>", `comma-separated subset of ${ALL_ENGINES.join(",")}`)
  .option("--branded-share <x>", "share of prompts that name the brand (reputation/comparisons)", "0.15")
  .action(async (url, o) => {
    const r = await onboard(url, {
      prompts: Number(o.prompts),
      topics: Number(o.topics),
      name: o.name,
      country: o.country,
      language: o.language,
      engines: o.engines ? parseEngines(o.engines) : undefined,
      brandedShare: Number(o.brandedShare),
    });
    const b = r.brand;
    out(`\n✓ Tracking ${b.name} (${b.domain}) as "${b.slug}"`);
    out(`  ${b.profile.one_liner}`);
    out(`  Category: ${b.profile.category}`);
    out(`  ICP: ${b.profile.icp.buyer_roles.slice(0, 3).join(", ")} · ${b.profile.icp.company_sizes.slice(0, 2).join(", ")}`);
    out(`  Competitors: ${b.competitors.map((c) => c.name).join(", ")}`);
    out(`  Topics: ${listTopics(b.id).map((t) => t.name).join(" · ")}`);
    out(`  Prompts: ${r.prompts}  ·  Claude tokens ${r.usage.inTokens.toLocaleString()} in / ${r.usage.outTokens.toLocaleString()} out`);
    const c = costEstimate(r.prompts, b.settings.engines);
    out(`  Estimated daily cost: ~$${c.totalPerDay} (DataForSEO ~$${c.dataforseoPerDay} + Claude ~$${c.claudePerDay}), ~$${c.totalPerMonth}/month`);
    out(`\nNext: gaio run --brand ${b.slug}   (try --limit 5 first)`);
  });

program
  .command("brands")
  .description("List tracked brands and their latest headline numbers")
  .option("--json")
  .action((o) => {
    const rows = brandSummaries();
    if (o.json) return asJson(rows);
    if (!rows.length) return out("No brands yet. Run `gaio onboard <url>`.");
    for (const b of rows) {
      out(
        `${b.slug.padEnd(20)} ${b.domain.padEnd(24)} ${String(b.prompts).padStart(4)} prompts  ` +
          (b.latest ? `${b.latest.date}: visibility ${pct(b.latest.visibility)}, cited ${pct(b.latest.citationRate)}, sentiment ${b.latest.sentiment?.toFixed(0) ?? "–"}` : "no runs yet"),
      );
    }
  });

program
  .command("profile")
  .description("Show the brand profile, ICP and competitors Claude derived from the website")
  .option("-b, --brand <ref>")
  .option("--json")
  .action((o) => {
    const b = resolveBrand(o.brand);
    if (o.json) return asJson(b);
    const p = b.profile;
    out(`${b.name} (${b.domain}) — ${p.category}\n\n${p.description}\n`);
    out(`Aliases: ${b.aliases.join(", ") || "–"}`);
    out(`Products: ${p.products.join("; ")}`);
    out(`Differentiators: ${p.differentiators.join("; ")}`);
    out(`ICP — industries: ${p.icp.industries.join("; ")}`);
    out(`ICP — company sizes: ${p.icp.company_sizes.join("; ")}`);
    out(`ICP — buyer roles: ${p.icp.buyer_roles.join("; ")}`);
    out(`ICP — pains: ${p.icp.pains.join("; ")}`);
    out(`Competitors: ${b.competitors.map((c) => `${c.name} (${c.domain})`).join(", ")}`);
    out(`Settings: ${b.settings.country}/${b.settings.language}, engines ${b.settings.engines.join(", ")}`);
  });

program
  .command("engines")
  .description(`Show or change which engines a brand runs on (${ALL_ENGINES.join(", ")})`)
  .option("-b, --brand <ref>")
  .option("--add <list>", "e.g. claude")
  .option("--remove <list>")
  .action((o) => {
    const b = resolveBrand(o.brand);
    let engines = b.settings.engines;
    if (o.add) engines = ALL_ENGINES.filter((e) => engines.includes(e) || parseEngines(o.add).includes(e));
    if (o.remove) engines = engines.filter((e) => !parseEngines(o.remove).includes(e));
    if (o.add || o.remove) updateBrand(b.id, { settings: { ...b.settings, engines } });
    const c = costEstimate(listPrompts(b.id).length, engines);
    out(`${b.slug}: ${engines.map((e) => ENGINE_LABELS[e]).join(", ")}`);
    out(`≈ $${c.totalPerDay}/day for ${c.prompts} prompts (${Object.entries(c.perEngineUsd).map(([e, v]) => `${e} $${v}`).join(", ")} per answer)`);
  });

program
  .command("competitors")
  .description("List, add or remove tracked competitors")
  .option("-b, --brand <ref>")
  .option("--add <name|domain>", 'e.g. "Asana|asana.com"')
  .option("--remove <name>")
  .action((o) => {
    const b = resolveBrand(o.brand);
    let competitors = b.competitors;
    if (o.add) {
      const [name, domain] = String(o.add).split("|").map((s) => s.trim());
      if (!name || !domain) throw new Error('Use --add "Name|domain.com"');
      competitors = [...competitors.filter((c) => c.name.toLowerCase() !== name.toLowerCase()), { name, domain: normalizeDomain(domain), aliases: [] }];
    }
    if (o.remove) competitors = competitors.filter((c) => c.name.toLowerCase() !== String(o.remove).toLowerCase());
    if (o.add || o.remove) updateBrand(b.id, { competitors });
    for (const c of competitors) out(`${c.name.padEnd(28)} ${c.domain}`);
  });

const prompts = program.command("prompts").description("Manage tracked prompts");

prompts
  .command("list", { isDefault: true })
  .option("-b, --brand <ref>")
  .option("--all", "include deactivated prompts")
  .option("--json")
  .action((o) => {
    const b = resolveBrand(o.brand);
    const rows = listPrompts(b.id, { activeOnly: !o.all });
    if (o.json) return asJson(rows);
    let topic: string | null | undefined;
    for (const p of rows.sort((x, y) => (x.topic ?? "").localeCompare(y.topic ?? "") || x.id - y.id)) {
      if (p.topic !== topic) out(`\n## ${(topic = p.topic) ?? "No topic"}`);
      out(`${String(p.id).padStart(5)}  ${p.branded ? "[B] " : ""}${p.active ? "" : "(off) "}${p.text}`);
    }
    out(`\n${rows.length} prompts · [B] = names the brand`);
  });

prompts
  .command("add <text...>")
  .description("Add one prompt (quote it) or several")
  .option("-b, --brand <ref>")
  .option("--topic <name>")
  .action((text: string[], o) => {
    const b = resolveBrand(o.brand);
    const topic = o.topic ? upsertTopic(b.id, o.topic, "", 1) : null;
    const aliases = [b.name, ...b.aliases];
    const items = text.length > 1 && text.every((t) => t.includes(" ")) ? text : [text.join(" ")];
    let added = 0;
    for (const t of items) {
      const branded = mentionsAny(t, aliases);
      if (insertPrompt(b.id, { text: t, topicId: topic?.id ?? null, intent: branded ? "branded" : "discovery", branded })) added++;
    }
    out(`Added ${added}. ${listPrompts(b.id).length} active prompts.`);
  });

prompts
  .command("remove <ids...>")
  .description("Stop tracking prompts by id (history is kept)")
  .option("-b, --brand <ref>")
  .action((ids: string[], o) => {
    const b = resolveBrand(o.brand);
    const n = setPromptsActive(b.id, ids.map(Number), false);
    out(`Deactivated ${n}. ${listPrompts(b.id).length} active prompts.`);
  });

prompts
  .command("generate <count>")
  .description("Generate more prompts across the brand's topics")
  .option("-b, --brand <ref>")
  .action(async (count: string, o) => {
    const b = resolveBrand(o.brand);
    const r = await generatePrompts(b, Number(count));
    out(`Added ${r.added}. ${listPrompts(b.id).length} active prompts.`);
  });

program
  .command("run")
  .description("Run every active prompt on every engine for today, then score mentions, citations and sentiment")
  .option("-b, --brand <ref>")
  .option("--all", "run every tracked brand")
  .option("--date <yyyy-mm-dd>", "label the run with another date", today())
  .option("--limit <n>", "only the first N prompts (testing)")
  .option("--engines <list>", `comma-separated subset of ${ALL_ENGINES.join(",")}`)
  .option("--force", "discard today's answers and start over")
  .option("--live", "use DataForSEO Live mode for ChatGPT/Gemini (faster, ~3x pricier than the queue)")
  .option("--email [to]", "email the report when done")
  .option("--quiet", "don't print the report")
  .action(async (o) => {
    const brands = o.all ? listBrands() : [resolveBrand(o.brand)];
    let failed = false;
    for (const b of brands) {
      const s = await runTracking(b, {
        date: o.date,
        limit: o.limit ? Number(o.limit) : undefined,
        engines: o.engines ? parseEngines(o.engines) : undefined,
        force: !!o.force,
        live: !!o.live,
      });
      if (s.run.status === "failed") failed = true;
      if (s.run.status === "failed") continue;
      const report = buildReport(b, s.run.run_date);
      if (!o.quiet) out("\n" + reportMarkdown(report));
      if (o.email) {
        const to = typeof o.email === "string" ? o.email : b.settings.email_to || config.emailTo;
        if (!to || !emailConfigured()) out("(email skipped: set RESEND_API_KEY, GAIO_EMAIL_FROM and GAIO_EMAIL_TO)");
        else out(`Emailed ${to} (id ${await sendReportEmail(report, buildTrend(b, 30), to)})`);
      }
    }
    if (failed) process.exitCode = 1;
  });

program
  .command("report")
  .description("Daily report: visibility, citations, sentiment, share of voice, competitors, gaps")
  .option("-b, --brand <ref>")
  .option("--date <yyyy-mm-dd>", "defaults to the latest run")
  .option("-f, --format <fmt>", "md | json | html", "md")
  .option("-o, --out <file>", "write to a file instead of stdout")
  .action((o) => {
    const b = resolveBrand(o.brand);
    const report = buildReport(b, o.date);
    const body =
      o.format === "json" ? JSON.stringify(report, null, 2) : o.format === "html" ? reportHtml(report, buildTrend(b, 30)) : reportMarkdown(report);
    if (o.out) {
      fs.mkdirSync(path.dirname(path.resolve(o.out)), { recursive: true });
      fs.writeFileSync(o.out, body);
      out(`Wrote ${path.resolve(o.out)}`);
    } else out(body);
  });

program
  .command("trend")
  .description("Visibility, citations, sentiment and share of voice over time")
  .option("-b, --brand <ref>")
  .option("--days <n>", "number of recent runs", "30")
  .option("--json")
  .action((o) => {
    const b = resolveBrand(o.brand);
    const points = buildTrend(b, Number(o.days));
    o.json ? asJson(points) : out(trendMarkdown(b.name, points));
  });

program
  .command("answers")
  .description("Read what the engines actually said")
  .option("-b, --brand <ref>")
  .option("--date <yyyy-mm-dd>")
  .option("-e, --engine <engine>", ALL_ENGINES.join("|"))
  .option("-p, --prompt <id>")
  .option("--missed", "only answers that do not mention the brand")
  .option("--mentioned", "only answers that mention the brand")
  .option("-n, --limit <n>", "max answers", "10")
  .option("--full", "print full answer text")
  .option("--json")
  .action((o) => {
    const b = resolveBrand(o.brand);
    const rows = answersFor(b, {
      date: o.date,
      engine: o.engine ? parseEngines(o.engine)[0] : undefined,
      promptId: o.prompt ? Number(o.prompt) : undefined,
      mentioned: o.missed ? false : o.mentioned ? true : undefined,
    })
      .filter((a) => a.available && !a.error)
      .slice(0, Number(o.limit));
    if (o.json) return asJson(rows);
    for (const a of rows) {
      out(`\n[${a.prompt_id}] ${a.prompt_text}\n— ${ENGINE_LABELS[a.engine]}${a.model ? ` (${a.model})` : ""}: ${a.mentioned ? `mentioned #${a.mention_rank ?? "?"}, ${a.sentiment ?? "?"}` : "not mentioned"}${a.cited ? `, cited at #${a.citation_position}` : ""}`);
      if (a.brand_context) out(`  "${a.brand_context}"`);
      out((o.full ? a.response_text : a.response_text.slice(0, 500) + (a.response_text.length > 500 ? " …" : "")).replace(/^/gm, "  "));
      if (a.citations.length) out(`  sources: ${a.citations.slice(0, 6).map((c) => c.domain || domainOf(c.url)).join(", ")}`);
    }
    if (!rows.length) out("No answers match.");
  });

program
  .command("status")
  .description("Check keys, DataForSEO balance/verification and estimated costs")
  .action(async () => {
    out(`Database: ${config.dbPath}`);
    out(`Claude: ${config.anthropicKey ? "key set" : "ANTHROPIC_API_KEY missing"} · onboarding ${config.model} · analysis ${config.analysisModel} (effort ${config.analysisEffort})`);
    const s = await new DataForSeoClient().status();
    out(`DataForSEO: ${s.login} · balance $${s.balance.toFixed(2)} · ${s.verified ? "verified" : "NOT VERIFIED — complete verification at https://app.dataforseo.com/"}${s.message && s.verified ? ` · ${s.message}` : ""}`);
    for (const b of brandSummaries()) {
      const c = costEstimate(b.prompts, b.engines);
      out(`${b.slug}: ${b.prompts} prompts × ${b.engines.length} engines ≈ $${c.totalPerDay}/day ($${c.totalPerMonth}/month) — ${c.basis}`);
    }
  });

program
  .command("cost")
  .description("Estimate daily and monthly cost")
  .option("-b, --brand <ref>")
  .option("--prompts <n>")
  .option("--engines <list>")
  .action((o) => {
    const brand = o.prompts && o.engines ? null : listBrands().length ? resolveBrand(o.brand) : null;
    const n = o.prompts ? Number(o.prompts) : brand ? listPrompts(brand.id).length : 100;
    const engines = o.engines ? parseEngines(o.engines) : (brand?.settings.engines ?? config.engines);
    asJson(costEstimate(n, engines));
  });

program
  .command("email")
  .description("Email the latest report")
  .option("-b, --brand <ref>")
  .option("--date <yyyy-mm-dd>")
  .option("--to <emails>")
  .action(async (o) => {
    const b = resolveBrand(o.brand);
    const to = o.to || b.settings.email_to || config.emailTo;
    if (!to) throw new Error("No recipient: pass --to or set GAIO_EMAIL_TO");
    const id = await sendReportEmail(buildReport(b, o.date), buildTrend(b, 30), to);
    out(`Sent to ${to} (id ${id})`);
  });

program
  .command("serve")
  .description("REST API + HTML dashboard")
  .option("--port <n>", "port", String(config.port))
  .action(async (o) => {
    const { startServer } = await import("./server.js");
    startServer(Number(o.port));
  });

program
  .command("mcp")
  .description("Run as an MCP server over stdio (for Claude Code, Cursor, etc.)")
  .action(async () => {
    const { startMcpServer } = await import("./mcp.js");
    await startMcpServer();
  });

program
  .command("cron")
  .description("Print a crontab line that runs every brand daily and emails the report")
  .option("--at <hh:mm>", "local time", "07:00")
  .action((o) => {
    const [h, m] = String(o.at).split(":").map(Number);
    const cli = path.join(ROOT, "dist", "cli.js");
    out(`# Add with: crontab -e`);
    out(`${m ?? 0} ${h ?? 7} * * * cd ${ROOT} && ${process.execPath} ${cli} run --all --quiet${emailConfigured() ? " --email" : ""} >> ${path.join(ROOT, "data", "cron.log")} 2>&1`);
  });

program.parseAsync().catch((err: Error) => {
  process.stderr.write(`Error: ${err.message}\n`);
  process.exit(1);
});
