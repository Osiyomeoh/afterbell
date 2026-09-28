"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import dynamic from "next/dynamic";

// The wallet button reads browser state, so it renders on the client only. Its labels match the
// page's own buttons ("Connect a wallet", where the adapter's default says "Select Wallet").
const WalletButton = dynamic(
  () =>
    import("@solana/wallet-adapter-react-ui").then(({ BaseWalletMultiButton }) => {
      const labels = {
        "change-wallet": "Change wallet",
        connecting: "Connecting…",
        "copy-address": "Copy address",
        copied: "Copied",
        disconnect: "Disconnect",
        "has-wallet": "Connect",
        "no-wallet": "Connect a wallet",
      };
      return function WalletButton() {
        return <BaseWalletMultiButton labels={labels} />;
      };
    }),
  { ssr: false },
);

const NAV: { href: string; label: string; wide?: boolean }[] = [
  { href: "/", label: "Protect" },
  { href: "/positions", label: "My protection" },
  { href: "/vault", label: "Vault" },
  { href: "/record", label: "Track record" },
  // No room on a phone's row; the home page and the footer link it there.
  { href: "/gap", label: "Gap report", wide: true },
];

export function Header() {
  const path = usePathname();
  return (
    <header className="border-b border-line">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-6 gap-y-3 px-4 py-4 sm:px-6 2xl:max-w-[88rem]">
        <Link href="/" className="flex items-center gap-2 text-lg font-semibold tracking-tight">
          <Bell />
          Afterbell
        </Link>
        {/* On phones the wallet button stays beside the name and the links take the row below. */}
        <nav className="order-last -mx-2.5 flex w-[calc(100%+1.25rem)] gap-1 overflow-x-auto text-sm sm:order-none sm:mx-0 sm:w-auto">
          {NAV.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              className={`rounded-md px-2.5 py-1.5 whitespace-nowrap sm:px-3 ${n.wide ? "hidden md:inline-block" : ""} ${path === n.href ? "bg-raised text-text" : "text-muted hover:text-text"}`}
            >
              {n.label}
            </Link>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-3">
          <span className="hidden rounded-full border border-line px-2.5 py-1 text-xs text-muted sm:inline">Test money only</span>
          <WalletButton />
        </div>
      </div>
    </header>
  );
}

function Bell() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15L6 16Z" stroke="var(--color-brass)" strokeWidth="1.8" strokeLinejoin="round" />
      <path d="M10 20.5a2 2 0 0 0 4 0" stroke="var(--color-brass)" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}
