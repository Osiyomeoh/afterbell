import { upcomingCloses } from "@root/quoter/calendar";

import { marketSnapshot, pricedStock } from "@/server/market";

export const dynamic = "force-dynamic";

/** How long before each close the reminder fires. */
const LEAD_SECS = 30 * 60;
const SESSIONS = 30;

const stamp = (unix: number) => new Date(unix * 1000).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

/**
 * A calendar to subscribe to: a reminder half an hour before each US close,
 * the last chance to protect a position overnight. Holidays and early closes
 * come from the oracle's market-hours schedule, so the feed stays right as calendars refresh it.
 */
export async function GET(req: Request) {
  const site = new URL(req.url).origin;
  const now = Math.floor(Date.now() / 1000);
  const m = await marketSnapshot(pricedStock("TSLA")!)
    .then((s) => s.market)
    .catch(() => null);
  const closes = upcomingCloses(now, SESSIONS, m?.holidays, m?.earlyCloses);
  const events = closes.flatMap((c) => [
    "BEGIN:VEVENT",
    `UID:close-${c.date}@afterbell`,
    `DTSTAMP:${stamp(now)}`,
    `DTSTART:${stamp(c.closeTs - LEAD_SECS)}`,
    `DTEND:${stamp(c.closeTs)}`,
    "SUMMARY:Afterbell: protect tonight's gap before the close",
    `DESCRIPTION:The market closes at ${new Date(c.closeTs * 1000).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" })} ET. Protection runs to the next open. ${site}`,
    `URL:${site}`,
    "BEGIN:VALARM",
    "ACTION:DISPLAY",
    "DESCRIPTION:Afterbell: 30 minutes to the close",
    "TRIGGER:PT0S",
    "END:VALARM",
    "END:VEVENT",
  ]);
  const body = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Afterbell//Pre-close alert//EN",
    "CALSCALE:GREGORIAN",
    "X-WR-CALNAME:Afterbell pre-close",
    "REFRESH-INTERVAL;VALUE=DURATION:P1D",
    "X-PUBLISHED-TTL:P1D",
    ...events,
    "END:VCALENDAR",
  ].join("\r\n");
  return new Response(body + "\r\n", {
    headers: { "content-type": "text/calendar; charset=utf-8", "content-disposition": 'inline; filename="afterbell.ics"', "cache-control": "public, max-age=3600" },
  });
}
