import http from "node:http";
import { config, parseEngines, type Engine } from "./config.js";
import { insertPrompt, listPrompts, listTopics, resolveBrand, setPromptsActive, upsertTopic } from "./db.js";
import { answersFor, buildReport, buildTrend } from "./metrics.js";
import { onboard } from "./onboarding.js";
import { reportHtml, reportMarkdown, trendMarkdown } from "./render.js";
import { brandSummaries, runStatus, startBackgroundRun } from "./service.js";
import { log, mentionsAny } from "./util.js";

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function readJson(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Body must be JSON");
  }
}

function send(res: http.ServerResponse, status: number, body: unknown, type = "application/json"): void {
  const payload = type === "application/json" ? JSON.stringify(body, null, 2) : String(body);
  res.writeHead(status, { "Content-Type": `${type}; charset=utf-8` });
  res.end(payload);
}

function authorized(req: http.IncomingMessage, url: URL): boolean {
  if (!config.apiToken) return true; // bound to localhost only
  const header = req.headers.authorization ?? "";
  return header === `Bearer ${config.apiToken}` || url.searchParams.get("token") === config.apiToken;
}

async function route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (!authorized(req, url)) throw new HttpError(401, "Missing or invalid token");
  const parts = url.pathname.split("/").filter(Boolean);
  const q = (k: string) => url.searchParams.get(k) ?? undefined;
  const tokenQs = config.apiToken ? `?token=${encodeURIComponent(config.apiToken)}` : "";

  if (req.method === "GET" && parts.length === 0) {
    const rows = brandSummaries()
      .map((b) => `<li><a href="/dashboard/${b.slug}${tokenQs}">${b.name}</a> — ${b.domain} · ${b.prompts} prompts${b.latest ? ` · last run ${b.latest.date}` : ""}</li>`)
      .join("");
    return send(res, 200, `<!doctype html><meta charset="utf-8"><title>GAIO</title><body style="font:15px system-ui;padding:24px"><h1>GAIO</h1><ul>${rows || "<li>No brands yet</li>"}</ul>`, "text/html");
  }

  if (req.method === "GET" && parts[0] === "dashboard" && parts[1]) {
    const brand = resolveBrand(parts[1]);
    return send(res, 200, reportHtml(buildReport(brand, q("date")), buildTrend(brand, 30)), "text/html");
  }

  if (parts[0] !== "v1") throw new HttpError(404, "Not found");

  if (parts[1] === "brands" && parts.length === 2) {
    if (req.method === "GET") return send(res, 200, brandSummaries());
    if (req.method === "POST") {
      const body = await readJson(req);
      if (!body.url) throw new HttpError(400, "url is required");
      const r = await onboard(body.url, {
        prompts: Number(body.prompts ?? 100),
        topics: body.topics ? Number(body.topics) : undefined,
        name: body.name,
        country: body.country,
        language: body.language,
        engines: body.engines ? parseEngines(String(body.engines)) : undefined,
      });
      return send(res, 201, { slug: r.brand.slug, name: r.brand.name, domain: r.brand.domain, prompts: r.prompts, competitors: r.brand.competitors });
    }
  }

  if (parts[1] === "brands" && parts[2]) {
    const brand = resolveBrand(decodeURIComponent(parts[2]));
    const sub = parts[3];

    if (req.method === "GET" && sub === "report") {
      const report = buildReport(brand, q("date"));
      const format = q("format") ?? "json";
      if (format === "md") return send(res, 200, reportMarkdown(report), "text/markdown");
      if (format === "html") return send(res, 200, reportHtml(report, buildTrend(brand, 30)), "text/html");
      return send(res, 200, report);
    }
    if (req.method === "GET" && sub === "trend") {
      const points = buildTrend(brand, Number(q("days") ?? 30));
      return q("format") === "md" ? send(res, 200, trendMarkdown(brand.name, points), "text/markdown") : send(res, 200, points);
    }
    if (sub === "prompts") {
      if (req.method === "GET") return send(res, 200, { topics: listTopics(brand.id), prompts: listPrompts(brand.id) });
      const body = await readJson(req);
      if (req.method === "POST") {
        const prompts: string[] = Array.isArray(body.prompts) ? body.prompts : [];
        if (!prompts.length) throw new HttpError(400, "prompts must be a non-empty array of strings");
        const t = body.topic ? upsertTopic(brand.id, String(body.topic), "", 1) : null;
        const aliases = [brand.name, ...brand.aliases];
        const added = prompts.map((p) =>
          insertPrompt(brand.id, { text: String(p), topicId: t?.id ?? null, intent: mentionsAny(p, aliases) ? "branded" : "discovery", branded: mentionsAny(p, aliases) }),
        );
        return send(res, 201, { added: added.filter(Boolean).length, active: listPrompts(brand.id).length });
      }
      if (req.method === "DELETE") {
        const ids: number[] = Array.isArray(body.ids) ? body.ids.map(Number) : [];
        return send(res, 200, { deactivated: setPromptsActive(brand.id, ids, false) });
      }
    }
    if (sub === "runs") {
      if (req.method === "POST") {
        const body = await readJson(req);
        const engines: Engine[] | undefined = body.engines ? parseEngines(String(body.engines)) : undefined;
        const r = startBackgroundRun(brand, { limit: body.limit ? Number(body.limit) : undefined, engines, date: body.date });
        return send(res, r.started ? 202 : 409, r);
      }
      if (req.method === "GET") return send(res, 200, runStatus(brand, q("date")));
    }
    if (req.method === "GET" && sub === "answers") {
      const mentioned = q("mentioned");
      const rows = answersFor(brand, {
        date: q("date"),
        engine: q("engine") as Engine | undefined,
        promptId: q("prompt_id") ? Number(q("prompt_id")) : undefined,
        mentioned: mentioned === undefined ? undefined : mentioned === "true",
      });
      return send(res, 200, rows);
    }
  }
  throw new HttpError(404, "Not found");
}

export function startServer(port = config.port): http.Server {
  const host = config.apiToken ? "0.0.0.0" : "127.0.0.1";
  const server = http.createServer((req, res) => {
    route(req, res).catch((err) => {
      const status = err instanceof HttpError ? err.status : /unknown brand|no runs|several brands|no brands/i.test(err.message) ? 404 : 500;
      if (status === 500) log(`  ${req.method} ${req.url}: ${err.stack ?? err.message}`);
      send(res, status, { error: err.message });
    });
  });
  server.listen(port, host, () => {
    log(`GAIO API listening on http://${host === "0.0.0.0" ? "localhost" : host}:${port}${config.apiToken ? " (token required)" : " (localhost only; set GAIO_API_TOKEN to expose it)"}`);
  });
  return server;
}
