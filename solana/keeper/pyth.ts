/**
 * Fetching the Pyth update a series settles on, from Hermes. Ported from
 * Weekend Markets' keeper.
 */
import { HermesClient } from "@pythnetwork/hermes-client";

import { settlementTimingError } from "./plan";

/** Pyth's upgraded Hermes (Pyth Core, since 2026-08-26), which needs an API key. */
export const HERMES_URL = process.env.PYTH_HERMES_URL || "https://pyth.dourolabs.app/hermes";

/** The API key is the user's, read from the environment and never stored. */
export function hermesFromEnv(): HermesClient {
  const accessToken = process.env.PYTH_API_KEY;
  if (!accessToken) throw new Error("PYTH_API_KEY is not set");
  return new HermesClient(HERMES_URL, { accessToken, timeout: 10_000 });
}

type ParsedUpdate = {
  id: string;
  price: { price: string; conf: string; expo: number; publish_time: number };
  metadata?: { prev_publish_time?: number };
};

export type SettlementUpdate = {
  /** Base64 update data, ready for Pyth's receiver to post. */
  data: string[];
  price: number;
  publishTime: number;
  prevPublishTime: number;
};

/** No print at or after the open yet: try again later. */
export class NotYetPublished extends Error {}
/** The first print after the open fell outside the window: the series can only void. */
export class NoPrintInWindow extends Error {}

/**
 * The first print at or after `openTs`, checked as the program will check it,
 * so we never pay to post an update the program would reject.
 */
export async function settlementUpdate(hermes: HermesClient, feedId: string, openTs: number, windowSecs: number): Promise<SettlementUpdate> {
  const res = await hermes.getPriceUpdatesAtTimestamp(openTs, [feedId], { parsed: true, encoding: "base64" });
  const parsed = (res.parsed ?? [])[0] as ParsedUpdate | undefined;
  if (!parsed) throw new NotYetPublished(`no update for ${feedId} at ${openTs} yet`);
  const publishTime = parsed.price.publish_time;
  const prev = parsed.metadata?.prev_publish_time;
  if (publishTime < openTs) throw new NotYetPublished(`the latest print (${publishTime}) is before the open (${openTs})`);
  if (prev === undefined) throw new Error("Hermes returned a print without its predecessor's time");
  const error = settlementTimingError(publishTime, prev, openTs, windowSecs);
  if (error) throw new NoPrintInWindow(error);
  return { data: res.binary.data, price: Number(parsed.price.price) * 10 ** parsed.price.expo, publishTime, prevPublishTime: prev };
}
