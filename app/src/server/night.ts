import { verifyView } from "./verify";

/** One settled night from the record, by its opening's timestamp. */
export async function nightView(openTs: string) {
  const ts = Number(openTs);
  if (!Number.isInteger(ts)) return null;
  const v = await verifyView();
  return v.nights.find((n) => n.openTs === ts) ?? null;
}
