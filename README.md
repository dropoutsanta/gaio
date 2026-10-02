# GAIO

**Self-hosted AIO/GEO monitoring engine that tracks your brand positioning across 100+ prompts for ±$3/day in costs.**


GAIO tracks how AI assistants talk about your brand. You give it a URL. Claude reads the site and works out what the company sells, its ICP and its competitors. It then defines prompt topics and writes the prompts real buyers would ask (100 by default).

Every day GAIO sends every prompt to every engine through DataForSEO and stores the answers. Claude then scores each answer: is the brand mentioned, at what position, with what sentiment, which competitors appear instead, and is your domain cited.

There is no UI to log into. It is a CLI, an MCP server for coding agents (Claude Code, Cursor) and a REST API. There is also an HTML dashboard and an optional daily email.

## Engines

| Engine | Source (DataForSEO) |
|---|---|
| ChatGPT | LLM Scraper: the real ChatGPT UI, fresh session, web search forced |
| Gemini | LLM Scraper: the real Gemini UI |
| Claude *(opt-in)* | LLM Responses: Claude API with web search, ~$0.10/answer, so off by default (`gaio engines --add claude`) |
| Perplexity | LLM Responses: Sonar (searches the web by default) |
| Google AI Mode | SERP API: `serp/google/ai_mode` |
| Google AI Overview | SERP API: organic SERP with `load_async_ai_overview` |

ChatGPT and Gemini go through DataForSEO's Standard queue by default. It costs about 70% less than Live mode, and results arrive in a few minutes. Use `gaio run --live` (or `DATAFORSEO_QUEUE=0`) when you need them right away.

Turn engines on or off per brand with `gaio engines --add claude` / `--remove gemini`. Set the defaults for new brands with `GAIO_ENGINES`.

## Setup

You need Node 20+, an [Anthropic API key](https://console.anthropic.com/) and a verified [DataForSEO](https://dataforseo.com/) account.

```bash
git clone https://github.com/dropoutsanta/gaio.git && cd gaio
npm install && npm run build
cp .env.example .env        # ANTHROPIC_API_KEY, DATAFORSEO_LOGIN, DATAFORSEO_PASSWORD
npm link                    # optional: puts `gaio` on your PATH (otherwise: node dist/cli.js …)
gaio status                 # checks keys, DataForSEO balance and account verification
```

DataForSEO only serves data once your account is verified at https://app.dataforseo.com/. Until then every call returns `40104`.

## Quickstart

```bash
gaio onboard yourcompany.com --prompts 100    # profile + ICP + competitors + topics + prompts
gaio prompts                                  # review / edit: prompts add "…", prompts remove 12 13
gaio run --limit 5                            # smoke test on 5 prompts
gaio run                                      # all prompts × all engines (re-running the same day only retries failures)
gaio report                                   # markdown; -f json | -f html -o report.html
gaio trend                                    # day by day
gaio answers --missed -e chatgpt              # what ChatGPT said when it didn't mention you
gaio serve                                    # REST API + dashboard on :8787
```

## What the numbers mean

- **Visibility**: share of answers to *unbranded* prompts that mention you. This is the headline number. Prompts that name you would mention you anyway, so they are left out.
- **Citation rate**: share of answers that cite your domain (or a subdomain) as a source.
- **Sentiment (0–100)**: how answers that mention you portray you (positive / neutral / negative), averaged.
- **Share of voice**: your mentions as a share of all brand mentions in unbranded answers.
- **Avg rank**: your position among the brands an answer names (1 = named first).
- **Leaderboard**: the same metrics for every competitor and for brands the engines recommend that you don't track yet. It is measured on *your* prompt set, so it compares you and the brands that come up in your results.
- **Gaps**: unbranded prompts where an engine recommends competitors and not you. This is your content to-do list.
- **Gained / lost**: prompt × engine pairs that started or stopped mentioning you since the previous run.

Roughly 15% of prompts are branded (reputation, pricing, "X vs Y"). Their main use is the sentiment score.

## Use it from Claude Code (MCP)

This folder ships a `.mcp.json`, so Claude Code opened here sees the `gaio` tools. To use it from any project:

```bash
claude mcp add gaio -s user -- node "$(pwd)/dist/cli.js" mcp   # run from the GAIO folder
```

Tools: `gaio_brands`, `gaio_report`, `gaio_trend`, `gaio_answers`, `gaio_prompts`, `gaio_add_prompts`, `gaio_remove_prompts`, `gaio_generate_prompts`, `gaio_onboard`, `gaio_run` (background) + `gaio_run_status`, `gaio_status`. Then ask things like *"how did we do in ChatGPT today, and which prompts did we lose?"*

## REST API

`gaio serve` listens on localhost only. Set `GAIO_API_TOKEN` to expose it; requests then need `Authorization: Bearer <token>`, or `?token=` for dashboard links.

| Method | Path | |
|---|---|---|
| GET | `/v1/brands` | brands + latest headline |
| POST | `/v1/brands` | `{url, prompts?, topics?, country?, language?, engines?}` → onboard |
| GET | `/v1/brands/:brand/report?date=&format=json\|md\|html` | daily report |
| GET | `/v1/brands/:brand/trend?days=30` | time series |
| GET/POST/DELETE | `/v1/brands/:brand/prompts` | list / `{prompts:[…], topic?}` / `{ids:[…]}` |
| POST | `/v1/brands/:brand/runs` | start today's run in the background |
| GET | `/v1/brands/:brand/runs` | run status |
| GET | `/v1/brands/:brand/answers?engine=&mentioned=false` | raw answers |
| GET | `/dashboard/:brand` | HTML dashboard |

## Daily schedule and email

```bash
gaio cron --at 07:00     # prints a crontab line: runs every brand, then emails the report
```

Email goes through [Resend](https://resend.com). Set `RESEND_API_KEY`, `GAIO_EMAIL_FROM` and `GAIO_EMAIL_TO`, then `gaio run --email` or `gaio email`.

## Costs

`gaio cost` estimates spend per day and per month. After the first runs it switches from list prices to the average DataForSEO actually billed per engine.

- **DataForSEO:** each answer's real cost is stored, and the report footer shows the run total.
- **Default setup** (5 engines, ChatGPT and Gemini queued): roughly $0.02 per prompt per day, plus ~$0.01 for scoring. That is about $3–4/day for 100 prompts.
- **The Claude engine** adds ~$0.10 per prompt per day (~$10/day for 100 prompts).
- **Scoring** each answer (mentioned? rank? sentiment?) runs on `claude-haiku-4-5`. Set `GAIO_ANALYSIS_MODEL=claude-sonnet-5-5` or `claude-opus-5-5` for higher-quality scoring at higher cost.
- **Onboarding** (profile, topics, prompts) runs once per brand on `claude-opus-5-5` (`GAIO_MODEL`).

## Several brands

One GAIO instance can track many brands (`--brand <slug>`, `run --all`). When two tracked brands compete with each other, each report adds a "tracked peers" section with the other brand's headline numbers. Those numbers come from that brand's own prompt set.

## Code map

`src/onboarding.ts` builds the profile, topics and prompts · `src/dataforseo.ts` is the engine client · `src/runner.ts` runs the daily job (resumable, retries failures, stops early if the provider is down) · `src/analyze.ts` scores mentions, rank and sentiment with Claude · `src/metrics.ts` computes the report · `src/render.ts` renders markdown and HTML · `src/mcp.ts`, `src/server.ts` and `src/cli.ts` are the interfaces · `src/db.ts` holds SQLite storage (`data/gaio.db`).

## License

MIT. See [LICENSE](LICENSE).
