// Adds ".js" to the relative imports in the emitted declarations, so projects on Node's own module
// resolution ("nodenext") find them; bundler-style resolution accepts either.
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const walk = (dir) => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]));
for (const file of walk("dist/types").filter((f) => f.endsWith(".d.ts"))) {
  const text = readFileSync(file, "utf8").replace(/(from\s+|import\()"(\.{1,2}\/[^"]+?)(?<!\.js|\.json)"/g, '$1"$2.js"');
  writeFileSync(file, text);
}
