import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { EvmDeployment } from "@root/evm/client/vault";

/**
 * The Robinhood Chain vault the app sells from, once it's deployed:
 * evm/deployments/robinhood.json, or EVM_DEPLOYMENT_FILE (a local fork, say).
 * Null until then, and the app says Robinhood Chain isn't live. next.config
 * traces evm/deployments into the quote route, so the file ships when hosted.
 */
export function evmDeployment(): EvmDeployment | null {
  const file = process.env.EVM_DEPLOYMENT_FILE || join(process.cwd(), "..", "evm", "deployments", "robinhood.json");
  return existsSync(/* turbopackIgnore: true */ file) ? (JSON.parse(readFileSync(/* turbopackIgnore: true */ file, "utf8")) as EvmDeployment) : null;
}
