"use client";

import { useEffect, useState } from "react";

/**
 * The other ways in: the Blink for any Solana wallet, and the MCP servers for
 * agents. Addresses use the page's own origin, so they're right wherever it's hosted.
 */
export function ForAgents() {
  // Empty until mounted, so the server render shows paths rather than a guessed host.
  const [origin, setOrigin] = useState("");
  useEffect(() => setOrigin(window.location.origin), []);
  const blink = `${origin}/api/actions/protect`;

  return (
    <section className="mt-16">
      <h2 className="text-xl font-semibold tracking-tight">For wallets and agents</h2>
      <div className="mt-5 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="rounded-2xl border border-line bg-surface p-5">
          <h3 className="font-medium">A Blink, in any Solana wallet</h3>
          <p className="mt-2 text-sm leading-relaxed text-muted">
            Protection from 2% to 10% below the price, as a Solana Action. &ldquo;Protect what I hold&rdquo; sizes it to the TSLAx and TSLAon in the
            wallet. A new devnet wallet is sent test money before it signs, so one click works from nothing.
          </p>
          {/* No "open it on dial.to" link: Dialect paused dial.to on 25 Sep (503 DEPLOYMENT_PAUSED, still on 26 Sep). */}
          <Copyable text={blink} />
        </div>
        <div className="rounded-2xl border border-line bg-surface p-5">
          <h3 className="font-medium">An MCP server, for AI agents</h3>
          <p className="mt-2 text-sm leading-relaxed text-muted">
            An agent can price protection, size it to a wallet&apos;s TSLA and follow its positions. The hosted server holds no keys and returns
            transactions for the agent&apos;s own wallet to sign. Run from the repo, the server gives the agent a devnet wallet of its own, with a
            spending cap on every purchase.
          </p>
          <Copyable text={`claude mcp add --transport http afterbell ${origin}/mcp`} />
          <Copyable text={`claude mcp add afterbell -e AFTERBELL_URL=${origin} -- npx tsx agent/server.ts`} />
        </div>
      </div>
    </section>
  );
}

function Copyable({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-3 flex items-center gap-2 rounded-lg border border-line bg-ink py-1.5 pr-1.5 pl-3">
      {/* Wrapped rather than scrolled, so the whole command shows on a phone. */}
      <code className="num min-w-0 flex-1 py-0.5 text-xs leading-relaxed break-all text-text">{text}</code>
      <button
        type="button"
        onClick={() =>
          navigator.clipboard.writeText(text).then(
            () => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            },
            () => {},
          )
        }
        className="shrink-0 rounded-md px-2 py-1 text-xs text-muted hover:bg-raised hover:text-text"
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
