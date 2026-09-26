/** Solana Actions discovery: a link to the Protect page unfurls as the protection Blink. */
export const dynamic = "force-static";

export function GET() {
  return Response.json(
    { rules: [{ pathPattern: "/", apiPath: "/api/actions/protect" }, { pathPattern: "/api/actions/**", apiPath: "/api/actions/**" }] },
    { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,OPTIONS" } },
  );
}
