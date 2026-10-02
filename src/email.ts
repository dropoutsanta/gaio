import { config } from "./config.js";
import type { Report } from "./metrics.js";
import { reportHtml, reportMarkdown } from "./render.js";
import type { TrendPoint } from "./metrics.js";
import { pct } from "./util.js";

export function emailConfigured(): boolean {
  return !!(config.resendKey && config.emailFrom);
}

// Sends the daily report through Resend (https://resend.com).
export async function sendReportEmail(report: Report, trend: TrendPoint[], to: string): Promise<string> {
  if (!emailConfigured()) throw new Error("Email is not configured: set RESEND_API_KEY and GAIO_EMAIL_FROM in .env");
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${config.resendKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: config.emailFrom,
      to: to.split(",").map((s) => s.trim()),
      subject: `${report.brand.name} AI visibility ${report.run.date}: ${pct(report.overall.visibility)} visible, ${pct(report.overall.citationRate)} cited`,
      html: reportHtml(report, trend),
      text: reportMarkdown(report),
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Resend ${res.status}: ${body.message ?? res.statusText}`);
  return body.id as string;
}
