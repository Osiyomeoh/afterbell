export type Status =
  | { kind: "idle" }
  | { kind: "busy"; step: string }
  | {
      kind: "done";
      premium: number;
      openTs: number;
      url: string | null;
      nft?: { number: string; art: string; share: string };
      /** Protect every night: until when and at most what, or why the standing order wasn't set. */
      renews?: { until: number; cap: number } | { error: string };
    }
  | { kind: "error"; message: string; needsFunds?: boolean };
