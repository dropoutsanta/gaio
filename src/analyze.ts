import * as z from "zod";
import { config, ENGINE_LABELS, type Engine } from "./config.js";
import { type Brand, saveAnalysis } from "./db.js";
import { structured, type Usage } from "./llm.js";
import { competitorKeys } from "./onboarding.js";
import { brandKey, mentionsAny } from "./util.js";

const AnalysisSchema = z.object({
  answers: z.array(
    z.object({
      id: z.string().describe("The answer id, e.g. A1"),
      target_mentioned: z.boolean(),
      target_rank: z
        .number()
        .nullable()
        .describe("1-based position of the target among the brands in `brands`; null when not mentioned"),
      target_sentiment: z.enum(["positive", "neutral", "negative", "not_mentioned"]),
      target_sentiment_score: z.number().describe("-1 (very negative) to 1 (very positive); 0 when not mentioned"),
      target_context: z.string().describe("Up to 25 words on how the answer portrays the target; empty when not mentioned"),
      brands: z
        .array(
          z.object({
            name: z.string(),
            sentiment: z.enum(["positive", "neutral", "negative"]),
          }),
        )
        .describe("Every company/product brand the answer names as an option, in order of first appearance, target included"),
    }),
  ),
});

function systemPrompt(brand: Brand): string {
  const known = brand.competitors.map((c) => `- ${c.name} (${c.domain})${c.aliases.length ? ` aka ${c.aliases.join(", ")}` : ""}`);
  return (
    "You audit how AI assistants talk about a target brand. For each answer, decide whether the target brand is " +
    "mentioned (by name, alias, product name or domain — inside the answer prose, not just in a URL), where it ranks " +
    "among the brands the answer names, and how the answer portrays it.\n\n" +
    "Sentiment is about the target only: positive = recommended/praised, neutral = listed without judgement, " +
    "negative = criticised, discouraged or flagged with drawbacks that dominate.\n" +
    "`brands` lists every vendor/product/company the answer offers as an option, in order of first appearance. Skip " +
    "publishers, review sites and the AI assistant itself unless they are offered as a solution. Use the canonical " +
    "names below whenever a brand refers to one of them.\n\n" +
    `Target brand: ${brand.name} (${brand.domain})${brand.aliases.length ? `, aka ${brand.aliases.join(", ")}` : ""}\n` +
    `Known competitors:\n${known.join("\n") || "- none listed"}`
  );
}

export interface AnswerToAnalyze {
  answerId: number;
  engine: Engine;
  text: string;
}

// Analyzes every engine's answer to one prompt in a single Claude call.
export async function analyzePrompt(brand: Brand, prompt: string, answers: AnswerToAnalyze[]): Promise<Usage> {
  const usable = answers.filter((a) => a.text.trim().length > 0);
  if (!usable.length) return { inTokens: 0, outTokens: 0 };
  const keys = competitorKeys(brand);
  const aliases = [brand.name, ...brand.aliases];

  try {
    const { data, usage } = await structured({
      schema: AnalysisSchema,
      model: config.analysisModel,
      effort: config.analysisEffort,
      maxTokens: 8000,
      system: systemPrompt(brand),
      user:
        `Prompt the user asked: ${prompt}\n\n` +
        usable.map((a, i) => `<answer id="A${i + 1}" engine="${ENGINE_LABELS[a.engine]}">\n${a.text}\n</answer>`).join("\n\n"),
    });

    usable.forEach((a, i) => {
      const r = data.answers.find((x) => x.id.trim().toUpperCase() === `A${i + 1}`) ?? data.answers[i];
      if (!r) return saveFallback(a, aliases);
      const brands = r.brands.map((b, idx) => {
        const known = keys.get(brandKey(b.name));
        return {
          key: brandKey(known?.name ?? b.name),
          name: known?.name ?? b.name.trim(),
          rank: idx + 1,
          sentiment: b.sentiment,
          isTarget: known?.isTarget ?? false,
        };
      });
      // Collapse repeats (e.g. a product name and the company name both listed).
      const unique = brands.filter((b, idx) => brands.findIndex((x) => x.key === b.key) === idx).map((b, idx) => ({ ...b, rank: idx + 1 }));
      let targetEntry = unique.find((b) => b.isTarget);
      const mentioned = r.target_mentioned || !!targetEntry;
      const sentiment = r.target_sentiment === "not_mentioned" ? (mentioned ? "neutral" : null) : r.target_sentiment;
      if (mentioned && !targetEntry) {
        targetEntry = { key: brandKey(brand.name), name: brand.name, rank: unique.length + 1, sentiment: sentiment ?? "neutral", isTarget: true };
        unique.push(targetEntry);
      }
      saveAnalysis(a.answerId, {
        mentioned,
        rank: mentioned ? (targetEntry?.rank ?? r.target_rank ?? null) : null,
        sentiment,
        sentimentScore: mentioned ? Math.max(-1, Math.min(1, r.target_sentiment_score)) : null,
        context: mentioned ? r.target_context : "",
        brands: unique,
      });
    });
    return usage;
  } catch (err) {
    // Keep the run going: record a text-match result and leave it marked unanalyzed for `gaio analyze`.
    for (const a of usable) saveFallback(a, aliases);
    throw err;
  }
}

function saveFallback(a: AnswerToAnalyze, aliases: string[]): void {
  const mentioned = mentionsAny(a.text, aliases);
  saveAnalysis(
    a.answerId,
    { mentioned, rank: null, sentiment: null, sentimentScore: null, context: "", brands: [] },
    false,
  );
}
