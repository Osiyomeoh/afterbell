import { statusReport } from "@/server/status";

export const dynamic = "force-dynamic";

/** What's running and whether it's keeping up, as JSON for a monitor. 503 when anything is down. */
export async function GET() {
  const report = await statusReport();
  const down = report.checks.some((c) => c.state === "down");
  return Response.json(report, { status: down ? 503 : 200, headers: { "cache-control": "no-store" } });
}
