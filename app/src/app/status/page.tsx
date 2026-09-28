import type { Metadata } from "next";

import { statusReport, type CheckState } from "@/server/status";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Status",
  description: "Whether Afterbell's keepers, hedge, quote service and faucet are running and keeping up.",
};

const DOT: Record<CheckState, string> = { ok: "bg-gain", warn: "bg-brass", down: "bg-loss" };
const WORD: Record<CheckState, string> = { ok: "Running", warn: "Needs a look", down: "Down" };

/** Live operations: each part of the service, read when the page loads. */
export default async function StatusPage() {
  const { now, checks } = await statusReport();
  const worst: CheckState = checks.some((c) => c.state === "down") ? "down" : checks.some((c) => c.state === "warn") ? "warn" : "ok";
  const headline = { ok: "Everything is running", warn: "Running, with something to look at", down: "Something is down" }[worst];

  return (
    <section className="mx-auto max-w-3xl py-10 sm:py-14">
      <h1 className="flex items-center gap-3 text-2xl font-semibold tracking-tight sm:text-3xl">
        <span className={`inline-block h-3 w-3 shrink-0 rounded-full ${DOT[worst]}`} aria-hidden="true" />
        {headline}
      </h1>
      <p className="mt-2 text-sm text-muted">
        Read at {new Date(now * 1000).toISOString().slice(11, 19)} UTC from the chains and the service&apos;s own settings. Reload to read again; the
        same report is JSON at <code className="num text-text">/api/status</code>.
      </p>
      <ul className="mt-6 divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">
        {checks.map((c) => (
          <li key={c.name} className="flex gap-3 px-4 py-3.5 sm:px-5">
            <span className={`mt-1.5 inline-block h-2.5 w-2.5 shrink-0 rounded-full ${DOT[c.state]}`} aria-hidden="true" />
            <div className="min-w-0">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-medium">{c.name}</span>
                <span className="text-xs text-faint">{WORD[c.state]}</span>
              </div>
              <p className="mt-0.5 text-sm leading-relaxed text-muted">
                {c.detail}{" "}
                {c.href && (
                  <a className="underline hover:text-text" href={c.href} target="_blank" rel="noreferrer">
                    View
                  </a>
                )}
              </p>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
