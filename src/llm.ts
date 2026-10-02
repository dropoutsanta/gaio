import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type * as z from "zod";
import { config, requireKey } from "./config.js";

let client: Anthropic | null = null;
function anthropic(): Anthropic {
  client ??= new Anthropic({ apiKey: requireKey("anthropic"), maxRetries: 4 });
  return client;
}

// Server-side refusal fallbacks are available on these models; effort is rejected on Haiku 4.5.
const FALLBACK_MODELS = ["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"];
const supportsEffort = (model: string) => !model.startsWith("claude-haiku");

export interface Usage {
  inTokens: number;
  outTokens: number;
}

export async function structured<S extends z.ZodType>(opts: {
  schema: S;
  system: string;
  user: string;
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  maxTokens?: number;
}): Promise<{ data: z.infer<S>; usage: Usage }> {
  const model = opts.model ?? config.model;
  const fallback = FALLBACK_MODELS.includes(model);
  const response = await anthropic().beta.messages.parse({
    model,
    max_tokens: opts.maxTokens ?? 16000,
    system: opts.system,
    messages: [{ role: "user", content: opts.user }],
    output_config: {
      format: betaZodOutputFormat(opts.schema),
      ...(supportsEffort(model) ? { effort: opts.effort ?? "medium" } : {}),
    },
    ...(fallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
  });

  if (response.stop_reason === "refusal") {
    throw new Error(`Claude declined the request (${response.stop_details?.category ?? "unknown category"})`);
  }
  if (response.stop_reason === "max_tokens") {
    throw new Error(`Claude ran out of output tokens (max_tokens=${opts.maxTokens ?? 16000})`);
  }
  if (response.parsed_output == null) {
    throw new Error("Claude returned output that did not match the expected schema");
  }
  return {
    data: response.parsed_output as z.infer<S>,
    usage: { inTokens: response.usage.input_tokens, outTokens: response.usage.output_tokens },
  };
}
