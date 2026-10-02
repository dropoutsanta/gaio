import { analyzePrompt, type AnswerToAnalyze } from "./analyze.js";
import { config, type Engine } from "./config.js";
import { DataForSeoClient, type EngineAnswer, ProviderFatalError, QUEUED_ENGINES } from "./dataforseo.js";
import {
  type Brand,
  type Run,
  addRunUsage,
  answersForRun,
  createRun,
  deletePendingTask,
  finishRun,
  getRun,
  getRunByDate,
  listPrompts,
  pendingTasks,
  resetRun,
  savePendingTask,
  upsertAnswer,
} from "./db.js";
import { log, pool, today } from "./util.js";

export interface RunOptions {
  date?: string;
  limit?: number;
  engines?: Engine[];
  force?: boolean;
  live?: boolean; // skip the cheaper queue for ChatGPT/Gemini
}

export interface RunSummary {
  run: Run;
  processed: number;
  engineErrors: number;
  analysisErrors: number;
  stoppedEarly: string | null;
}

// Consecutive prompts where every engine failed before we assume the provider is down.
const BREAKER = 5;

export async function runTracking(brand: Brand, opts: RunOptions = {}): Promise<RunSummary> {
  const date = opts.date ?? today();
  const engines = opts.engines ?? brand.settings.engines ?? config.engines;
  let prompts = listPrompts(brand.id);
  if (opts.limit) prompts = prompts.slice(0, opts.limit);
  if (!prompts.length) throw new Error(`${brand.name} has no active prompts`);

  const existing = getRunByDate(brand.id, date);
  const recent = new Date(Date.now() - 2 * 3600_000).toISOString().replace("T", " ").slice(0, 19);
  if (!opts.force && existing?.status === "running" && existing.started_at > recent) {
    throw new Error(`A run for ${brand.name} on ${date} started at ${existing.started_at} UTC is still marked running. Wait for it, or pass --force to restart.`);
  }
  let run = createRun(brand.id, date, engines, prompts.length);
  if (opts.force) resetRun(run.id);

  // Work out what is still missing: failed engines are retried, finished ones are kept.
  const have = new Map<string, { id: number; engine: Engine; error: string | null; analyzed: boolean; available: boolean; text: string }>();
  for (const a of answersForRun(run.id)) {
    have.set(`${a.prompt_id}:${a.engine}`, { id: a.id, engine: a.engine, error: a.error, analyzed: a.analyzed, available: a.available, text: a.response_text });
  }
  const work = prompts
    .map((prompt) => {
      const fetch = engines.filter((e) => {
        const h = have.get(`${prompt.id}:${e}`);
        return !h || !!h.error;
      });
      const reanalyze = engines
        .filter((e) => !fetch.includes(e))
        .map((e) => have.get(`${prompt.id}:${e}`)!)
        .filter((h) => h.available && !h.analyzed && h.text);
      return { prompt, fetch, reanalyze };
    })
    .filter((w) => w.fetch.length || w.reanalyze.length);

  if (!work.length) {
    finishRun(run.id, "complete");
    log(`Nothing to do: ${date} is already complete for ${brand.name}.`);
    return { run: getRun(run.id)!, processed: 0, engineErrors: 0, analysisErrors: 0, stoppedEarly: null };
  }

  const provider = new DataForSeoClient();
  log(`Run ${date} · ${brand.name} · ${work.length} prompt(s) × ${engines.length} engine(s)`);

  let processed = 0;
  let engineErrors = 0;
  let analysisErrors = 0;
  let allFailedStreak = 0;
  let stoppedEarly: string | null = null;
  const common = { domain: brand.domain, country: brand.settings.country ?? config.country, language: brand.settings.language ?? config.language };

  // ChatGPT/Gemini go to DataForSEO's Standard queue up front; prompts are processed as results land.
  const queued = pendingTasks(run.id);
  if (config.dataforseoQueue && !opts.live) {
    const toPost = work.flatMap(({ prompt, fetch }) =>
      fetch.filter((e) => QUEUED_ENGINES.includes(e) && !queued.has(`${prompt.id}:${e}`)).map((engine) => ({ prompt, engine })),
    );
    try {
      await Promise.all(
        toPost.map(async ({ prompt, engine }) => {
          try {
            const t = await provider.enqueue(engine, { ...common, prompt: prompt.text });
            savePendingTask(run.id, prompt.id, engine, t.taskId, t.cost);
            queued.set(`${prompt.id}:${engine}`, t);
          } catch (err) {
            if (err instanceof ProviderFatalError) throw err;
            log(`  could not queue ${engine} for prompt ${prompt.id} (${(err as Error).message}); it will run live`);
          }
        }),
      );
    } catch (err) {
      stoppedEarly = (err as Error).message;
    }
    if (toPost.length && !stoppedEarly) log(`  queued ${toPost.length} ChatGPT/Gemini task(s); results usually take a few minutes`);
  }

  await pool(
    work,
    config.promptConcurrency,
    async ({ prompt, fetch, reanalyze }) => {
      let answers: EngineAnswer[];
      try {
        answers = await Promise.all(
          fetch.map((engine) => {
            const q = queued.get(`${prompt.id}:${engine}`);
            return q ? provider.collect(engine, q.taskId, brand.domain, q.cost) : provider.answer(engine, { ...common, prompt: prompt.text });
          }),
        );
      } catch (err) {
        if (err instanceof ProviderFatalError) stoppedEarly ??= err.message;
        else log(`  ✗ prompt ${prompt.id}: ${(err as Error).message}`);
        return;
      }

      const saved = answers.map((a) => ({
        engine: a.engine,
        answer: a,
        id: upsertAnswer({
          runId: run.id,
          promptId: prompt.id,
          engine: a.engine,
          model: a.model,
          available: a.available,
          responseText: a.responseText,
          citations: a.citations,
          cited: a.cited,
          citationPosition: a.citationPosition,
          error: a.error,
          cost: a.cost,
        }),
      }));
      addRunUsage(run.id, { apiCalls: answers.length, apiCost: answers.reduce((s, a) => s + a.cost, 0) });
      for (const a of answers) {
        // Keep a still-pending task for the next run; drop finished or failed ones so they get re-posted.
        if (queued.has(`${prompt.id}:${a.engine}`) && !a.error?.includes("not ready after")) deletePendingTask(run.id, prompt.id, a.engine);
      }

      const failed = answers.filter((a) => a.error);
      engineErrors += failed.length;
      if (answers.length && failed.length === answers.length) {
        if (++allFailedStreak >= BREAKER) {
          stoppedEarly ??= `Every engine failed on ${BREAKER} prompts in a row (last error: ${failed[0]!.error}). Run \`gaio run\` again later; finished answers are kept.`;
        }
      } else if (answers.length) {
        allFailedStreak = 0;
      }

      const toAnalyze: AnswerToAnalyze[] = [
        ...saved.filter((s) => s.answer.available && s.answer.responseText).map((s) => ({ answerId: s.id, engine: s.engine, text: s.answer.responseText })),
        ...reanalyze.map((h) => ({ answerId: h.id, engine: h.engine, text: h.text })),
      ];
      if (toAnalyze.length) {
        try {
          const usage = await analyzePrompt(brand, prompt.text, toAnalyze);
          addRunUsage(run.id, { inTokens: usage.inTokens, outTokens: usage.outTokens });
        } catch (err) {
          analysisErrors++;
          log(`  ! analysis failed for prompt ${prompt.id}: ${(err as Error).message}`);
        }
      }
      processed++;
      const marks = answers.map((a) => `${a.engine}:${a.error ? "✗" : a.available ? "✓" : "–"}`).join(" ");
      log(`  [${processed}/${work.length}] ${marks}  ${prompt.text.slice(0, 70)}`);
      for (const f of failed) log(`      ${f.engine}: ${f.error}`);
    },
    () => stoppedEarly !== null,
  );

  const after = answersForRun(run.id);
  const done = new Set(after.filter((a) => !a.error).map((a) => `${a.prompt_id}:${a.engine}`));
  const missing = prompts.reduce((n, p) => n + engines.filter((e) => !done.has(`${p.id}:${e}`)).length, 0);
  const status: Run["status"] = missing === 0 ? "complete" : done.size ? "partial" : "failed";
  finishRun(run.id, status, stoppedEarly ?? (missing ? `${missing} engine answer(s) missing or failed; run again to retry them` : null));
  run = getRun(run.id)!;
  log(
    `Run ${run.status}: ${processed} prompt(s) processed, ${missing} answer(s) missing · DataForSEO $${run.api_cost.toFixed(3)} · Claude ${run.llm_input_tokens} in / ${run.llm_output_tokens} out tokens`,
  );
  if (stoppedEarly) log(`Stopped early: ${stoppedEarly}`);
  return { run, processed, engineErrors, analysisErrors, stoppedEarly };
}
