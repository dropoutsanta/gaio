import * as z from "zod";
import { config, type Engine } from "./config.js";
import {
  type Brand,
  type BrandProfile,
  type Competitor,
  type Topic,
  insertBrand,
  insertPrompt,
  listBrands,
  listPrompts,
  listTopics,
  upsertTopic,
} from "./db.js";
import { structured, type Usage } from "./llm.js";
import { crawlSite, normalizeUrl, type Page } from "./site.js";
import { brandKey, domainOf, log, mentionsAny, normalizeDomain, pool, slugify } from "./util.js";

export const BRAND_TOPIC = "Brand & reputation";

const ProfileSchema = z.object({
  name: z.string().describe("The brand name as customers say it"),
  aliases: z.array(z.string()).describe("Other names people use: product names, short names, legal name. Exclude generic words."),
  one_liner: z.string(),
  description: z.string().describe("3-5 sentences: what it is, who it serves, how it works"),
  category: z.string().describe("The market category buyers would search for, e.g. 'project management software'"),
  products: z.array(z.string()),
  value_props: z.array(z.string()),
  differentiators: z.array(z.string()),
  icp: z.object({
    industries: z.array(z.string()),
    company_sizes: z.array(z.string()),
    buyer_roles: z.array(z.string()),
    pains: z.array(z.string()),
    geographies: z.array(z.string()),
  }),
  use_cases: z.array(z.string()),
  pricing_model: z.string(),
  competitors: z
    .array(z.object({ name: z.string(), domain: z.string(), aliases: z.array(z.string()) }))
    .describe("5-10 real companies buyers compare against this brand, most direct first"),
});

const TopicsSchema = z.object({
  topics: z.array(
    z.object({
      name: z.string().describe("2-5 words"),
      description: z.string().describe("What buyers are trying to figure out in this topic"),
      weight: z.number().describe("1-5: how commercially important this topic is for the brand"),
    }),
  ),
});

const PromptsSchema = z.object({
  prompts: z.array(
    z.object({
      text: z.string(),
      intent: z.enum(["discovery", "problem", "comparison", "branded"]),
    }),
  ),
});

function pagesBlock(pages: Page[]): string {
  if (!pages.length) return "(The website could not be fetched. Use what you know about this domain.)";
  return pages
    .map((p) => `### ${p.url}\nTitle: ${p.title}\nMeta description: ${p.description}\n\n${p.text}`)
    .join("\n\n---\n\n");
}

export function profileBlock(brand: Pick<Brand, "name" | "domain" | "aliases" | "profile" | "competitors">): string {
  const p = brand.profile;
  return [
    `Brand: ${brand.name} (${brand.domain})`,
    brand.aliases.length ? `Also known as: ${brand.aliases.join(", ")}` : "",
    `Category: ${p.category}`,
    `What it is: ${p.description}`,
    `Products: ${p.products.join("; ")}`,
    `Value props: ${p.value_props.join("; ")}`,
    `Differentiators: ${p.differentiators.join("; ")}`,
    `ICP industries: ${p.icp.industries.join("; ")}`,
    `ICP company sizes: ${p.icp.company_sizes.join("; ")}`,
    `ICP buyer roles: ${p.icp.buyer_roles.join("; ")}`,
    `ICP pains: ${p.icp.pains.join("; ")}`,
    `Geographies: ${p.icp.geographies.join("; ")}`,
    `Use cases: ${p.use_cases.join("; ")}`,
    `Pricing model: ${p.pricing_model}`,
    `Competitors: ${brand.competitors.map((c) => `${c.name} (${c.domain})`).join("; ")}`,
  ]
    .filter(Boolean)
    .join("\n");
}

// Largest-remainder split of `total` across weights, every bucket getting at least one when possible.
export function allocate(total: number, weights: number[]): number[] {
  if (!weights.length) return [];
  const sum = weights.reduce((a, b) => a + b, 0) || weights.length;
  const raw = weights.map((w) => (total * (w || 1)) / sum);
  const out = raw.map(Math.floor);
  let left = total - out.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => [r - Math.floor(r), i] as const).sort((a, b) => b[0] - a[0]);
  for (let k = 0; left > 0; k = (k + 1) % order.length, left--) out[order[k]![1]]!++;
  if (total >= weights.length) {
    for (let i = 0; i < out.length; i++) {
      while (out[i] === 0) {
        const donor = out.indexOf(Math.max(...out));
        out[donor]!--;
        out[i]!++;
      }
    }
  }
  return out;
}

export async function buildProfile(url: string, nameHint?: string): Promise<{
  finalUrl: string;
  name: string;
  aliases: string[];
  profile: BrandProfile;
  competitors: Competitor[];
  usage: Usage;
}> {
  log(`→ Reading ${normalizeUrl(url)} …`);
  const site = await crawlSite(url);
  log(`  fetched ${site.pages.length} page(s)`);
  log("→ Building company profile & ICP with Claude …");
  const { data, usage } = await structured({
    schema: ProfileSchema,
    effort: "medium",
    system:
      "You are a senior market analyst. From a company's website you produce a precise positioning profile: " +
      "what it sells, the category buyers would search for, its ideal customer profile, and the real competitors buyers " +
      "evaluate it against. Be specific and factual; use your own market knowledge to fill gaps the website leaves, " +
      "especially for competitors. Never invent products the site does not support.",
    user:
      `Website: ${site.finalUrl}\n${nameHint ? `The brand is called: ${nameHint}\n` : ""}\n` +
      `Pages fetched from the site:\n\n${pagesBlock(site.pages)}`,
  });
  const domain = domainOf(site.finalUrl);
  const competitors = data.competitors
    .map((c) => ({ name: c.name.trim(), domain: normalizeDomain(c.domain), aliases: c.aliases.filter(Boolean) }))
    .filter((c) => c.name && c.domain !== domain);
  const { name, aliases, competitors: _c, ...profile } = data;
  return {
    finalUrl: site.finalUrl,
    name: nameHint || name.trim(),
    aliases: [...new Set(aliases.map((a) => a.trim()).filter((a) => a && a.toLowerCase() !== name.toLowerCase()))],
    profile,
    competitors,
    usage,
  };
}

export async function generateTopics(brand: Brand, count: number): Promise<{ topics: Topic[]; usage: Usage }> {
  log(`→ Defining ${count} prompt topics …`);
  const { data, usage } = await structured({
    schema: TopicsSchema,
    effort: "medium",
    system:
      "You design prompt sets for tracking a brand's visibility in AI assistants (ChatGPT, Claude, Gemini, Perplexity, " +
      "Google AI Overviews). A topic is a cluster of questions real prospective customers ask an AI assistant while " +
      "looking for a solution in this brand's market. Topics must be about the buyer's problem space and category, " +
      "not about the brand itself. Cover the funnel: category discovery, specific pains/jobs-to-be-done, use cases, " +
      "segment-specific needs (industry, company size, role), and evaluation criteria (pricing, integrations, alternatives).",
    user: `${profileBlock(brand)}\n\nDefine exactly ${count} distinct, non-overlapping topics.`,
  });
  const topics = data.topics
    .slice(0, count)
    .map((t) => upsertTopic(brand.id, t.name.trim(), t.description.trim(), Math.min(5, Math.max(1, Math.round(t.weight)))));
  return { topics, usage };
}

async function promptsForTopic(
  brand: Brand,
  topic: Topic,
  count: number,
  existing: string[],
  language: string,
): Promise<{ prompts: { text: string; intent: string }[]; usage: Usage }> {
  const branded = topic.name === BRAND_TOPIC;
  const rules = branded
    ? `Every prompt must name ${brand.name} explicitly. Mix: reviews and reputation ("is ${brand.name} any good for…"), ` +
      `pricing and value, head-to-head comparisons with the named competitors, "alternatives to ${brand.name}", and ` +
      `fit for specific ICP situations. Use intent "branded".`
    : `Prompts must NOT mention ${brand.name}${brand.aliases.length ? ` or ${brand.aliases.join(", ")}` : ""}. ` +
      `They may name competitors (e.g. "alternatives to <competitor>", "<competitor> vs <competitor>"). ` +
      `Use intent "discovery" (best X for Y / recommend a tool), "problem" (how do I solve a pain), or "comparison".`;
  const { data, usage } = await structured({
    schema: PromptsSchema,
    effort: "medium",
    system:
      "You write the exact messages real people type into AI assistants (ChatGPT, Gemini, Perplexity, Claude, Google) " +
      "when they need a product or service. We send each prompt to every assistant daily and check whether the brand " +
      "is recommended, so prompts must be the kind whose honest answer names specific vendors or products.\n\n" +
      "Write like real users: vary length (from 6-word queries to 2-3 sentence messages with context), vary persona " +
      "(roles, company sizes, industries, budgets, regions from the ICP), include concrete constraints " +
      "(team size, stack, budget, compliance), and keep one question per prompt. Keep every prompt under 400 characters. " +
      "No numbering, no quotes, no hashtags.",
    user:
      `${profileBlock(brand)}\n\nTopic: ${topic.name}\nTopic focus: ${topic.description}\n\n` +
      `Write exactly ${count} prompts for this topic in language "${language}".\n${rules}\n` +
      (existing.length ? `\nDo not repeat or closely paraphrase these existing prompts:\n${existing.map((e) => `- ${e}`).join("\n")}` : ""),
  });
  return { prompts: data.prompts, usage };
}

const normText = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

// Adds `count` new prompts across the brand's topics (weighted), skipping near-duplicates.
export async function generatePrompts(
  brand: Brand,
  count: number,
  opts: { brandedShare?: number; language?: string } = {},
): Promise<{ added: number; usage: Usage }> {
  const topics = listTopics(brand.id);
  if (!topics.length) throw new Error("Brand has no topics yet");
  const brandedShare = opts.brandedShare ?? 0.15;
  const brandTopic = topics.find((t) => t.name === BRAND_TOPIC);
  const others = topics.filter((t) => t.name !== BRAND_TOPIC);
  const brandedCount = brandTopic ? Math.round(count * brandedShare) : 0;
  const split = allocate(count - brandedCount, others.map((t) => t.weight));
  const plan: [Topic, number][] = others.map((t, i) => [t, split[i]!] as [Topic, number]);
  if (brandTopic && brandedCount > 0) plan.push([brandTopic, brandedCount]);

  const existing = listPrompts(brand.id, { activeOnly: false });
  const seen = new Set(existing.map((p) => normText(p.text)));
  const aliases = [brand.name, ...brand.aliases];
  const usage: Usage = { inTokens: 0, outTokens: 0 };
  let added = 0;

  await pool(
    plan.filter(([, n]) => n > 0),
    4,
    async ([topic, n]) => {
      let need = n;
      for (let attempt = 0; attempt < 2 && need > 0; attempt++) {
        const prior = existing.filter((p) => p.topic_id === topic.id).map((p) => p.text);
        const res = await promptsForTopic(brand, topic, need, prior, opts.language ?? brand.settings.language ?? config.language);
        usage.inTokens += res.usage.inTokens;
        usage.outTokens += res.usage.outTokens;
        for (const p of res.prompts) {
          if (need <= 0) break;
          const key = normText(p.text);
          if (!key || seen.has(key) || p.text.length > 500) continue; // LLM APIs cap prompts at 500 chars
          const isBranded = mentionsAny(p.text, aliases);
          if (topic.name !== BRAND_TOPIC && isBranded) continue; // keep unbranded topics clean
          seen.add(key);
          const row = insertPrompt(brand.id, {
            text: p.text,
            topicId: topic.id,
            intent: isBranded ? "branded" : p.intent === "branded" ? "discovery" : p.intent,
            branded: isBranded,
          });
          if (row) {
            existing.push(row);
            added++;
            need--;
          }
        }
      }
      log(`  ${topic.name}: ${n - need}/${n} prompts`);
    },
  );
  return { added, usage };
}

export async function onboard(
  url: string,
  opts: {
    prompts: number;
    topics?: number;
    name?: string;
    country?: string;
    language?: string;
    engines?: Engine[];
    brandedShare?: number;
  },
): Promise<{ brand: Brand; prompts: number; usage: Usage }> {
  const domain = domainOf(normalizeUrl(url));
  const clash = listBrands().find((b) => b.domain === domain);
  if (clash) throw new Error(`${domain} is already tracked as "${clash.slug}". Use \`gaio prompts generate\` to add prompts.`);

  const p = await buildProfile(url, opts.name);
  let slug = slugify(p.name);
  if (listBrands().some((b) => b.slug === slug)) slug = `${slug}-${slugify(domain)}`;
  const brand = insertBrand({
    slug,
    name: p.name,
    domain: domainOf(p.finalUrl) || domain,
    url: p.finalUrl,
    aliases: p.aliases,
    profile: p.profile,
    competitors: p.competitors,
    settings: {
      country: opts.country ?? config.country,
      language: opts.language ?? config.language,
      engines: opts.engines ?? config.engines,
    },
  });
  log(`  ${brand.name} — ${brand.profile.category}`);
  log(`  competitors: ${brand.competitors.map((c) => c.name).join(", ")}`);

  const t = await generateTopics(brand, opts.topics ?? 8);
  if ((opts.brandedShare ?? 0.15) > 0) {
    upsertTopic(brand.id, BRAND_TOPIC, `How AI assistants describe ${brand.name}: reputation, pricing, comparisons and alternatives.`, 3);
  }
  log(`→ Generating ${opts.prompts} prompts …`);
  const g = await generatePrompts(brand, opts.prompts, { brandedShare: opts.brandedShare, language: brand.settings.language });
  const usage = {
    inTokens: p.usage.inTokens + t.usage.inTokens + g.usage.inTokens,
    outTokens: p.usage.outTokens + t.usage.outTokens + g.usage.outTokens,
  };
  return { brand, prompts: g.added, usage };
}

export function competitorKeys(brand: Brand): Map<string, { name: string; domain: string | null; isTarget: boolean }> {
  const m = new Map<string, { name: string; domain: string | null; isTarget: boolean }>();
  for (const a of [brand.name, ...brand.aliases]) m.set(brandKey(a), { name: brand.name, domain: brand.domain, isTarget: true });
  for (const c of brand.competitors) {
    for (const a of [c.name, ...c.aliases]) {
      if (!m.has(brandKey(a))) m.set(brandKey(a), { name: c.name, domain: c.domain, isTarget: false });
    }
  }
  return m;
}
