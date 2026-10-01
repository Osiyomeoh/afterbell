"use client";

import { useEffect, useState } from "react";

/** Share a page on X or Telegram, or copy its link. The links wait for the page's own address. */
export function ShareButtons({ text }: { text: string }) {
  const [url, setUrl] = useState("");
  const [copied, setCopied] = useState(false);
  useEffect(() => setUrl(window.location.href), []);

  const x = `https://x.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`;
  const telegram = `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`;
  const cls = "rounded-lg border border-line px-3.5 py-2 text-sm hover:border-brass aria-disabled:pointer-events-none aria-disabled:opacity-40";
  return (
    <div className="mt-6 flex flex-wrap gap-2">
      <a className={`${cls} bg-brass font-medium text-ink hover:opacity-90`} href={url ? x : undefined} aria-disabled={!url} target="_blank" rel="noreferrer">
        Share on X
      </a>
      <a className={cls} href={url ? telegram : undefined} aria-disabled={!url} target="_blank" rel="noreferrer">
        Telegram
      </a>
      <button
        type="button"
        className={cls}
        disabled={!url}
        onClick={() =>
          navigator.clipboard.writeText(url).then(
            () => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            },
            () => {},
          )
        }
      >
        {copied ? "Copied" : "Copy link"}
      </button>
    </div>
  );
}
