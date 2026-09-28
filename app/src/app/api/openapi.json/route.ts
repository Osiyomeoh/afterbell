import { openApiSpec } from "@root/sdk/openapi";

/** The public API as an OpenAPI 3.1 document, naming this deployment as its server. */
export function GET(request: Request) {
  return Response.json(openApiSpec(new URL(request.url).origin), { headers: { "access-control-allow-origin": "*" } });
}
