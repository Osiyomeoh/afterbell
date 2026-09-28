import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { describe, expect, it } from "vitest";

import { openApiSpec } from "./openapi";

const API = join(import.meta.dirname, "..", "app", "src", "app", "api");

/** Every route file under app/src/app/api, as an OpenAPI path ([id] → {id}) with the methods it exports. */
function routes(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === "route.ts") {
        const path = "/api/" + relative(API, dir).split(sep).map((s) => s.replace(/^\[(.+)\]$/, "{$1}")).join("/");
        const src = readFileSync(p, "utf8");
        // OPTIONS only answers browsers' cross-origin preflight; it isn't part of the API.
        const methods = [...src.matchAll(/export (?:async )?function (GET|POST|PUT|PATCH|DELETE)\b/g)].map((m) => m[1]!.toLowerCase());
        out.set(path, new Set(methods));
      }
    }
  };
  walk(API);
  return out;
}

/** The status codes a route file answers with, from `{ status: NNN }` and its helpers' `, NNN)`. */
function statuses(path: string): Set<string> {
  const file = join(API, ...path.replace(/^\/api\//, "").split("/").map((s) => s.replace(/^\{(.+)\}$/, "[$1]")), "route.ts");
  const src = readFileSync(file, "utf8");
  return new Set([...src.matchAll(/(?:status: |, )([45]\d\d)\b/g)].map((m) => m[1]!));
}

describe("the OpenAPI document", () => {
  const spec = openApiSpec("https://afterbell.example");
  const documented = spec.paths as Record<string, Record<string, { responses: Record<string, unknown> }>>;

  it("documents every route the app serves, with the methods it answers, and nothing else", () => {
    const served = routes();
    expect(Object.keys(documented).sort()).toEqual([...served.keys()].sort());
    for (const [path, methods] of served) expect(Object.keys(documented[path]!).sort(), path).toEqual([...methods].sort());
  });

  it("lists every error status each route can answer with", () => {
    for (const path of routes().keys()) {
      const listed = new Set(Object.values(documented[path]!).flatMap((op) => Object.keys(op.responses)));
      for (const status of statuses(path)) expect(listed.has(status), `${path} answers ${status}`).toBe(true);
    }
  });

  it("resolves every schema it refers to", () => {
    const names = new Set(Object.keys(spec.components.schemas));
    const refs = [...JSON.stringify(spec).matchAll(/"#\/components\/schemas\/(\w+)"/g)].map((m) => m[1]!);
    expect(refs.filter((r) => !names.has(r))).toEqual([]);
  });
});
