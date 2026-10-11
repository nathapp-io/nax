import { runTrustGate } from "../cli";
import type { PrecheckOptions } from "./precheck";
import { precheckCommand } from "./precheck";

export const _doctorDeps = { runTrustGate, precheckCommand };

/** Run the light precheck under the doctor alias. */
export async function doctorCommand(options: { dir: string; json?: boolean }): Promise<void> {
  await _doctorDeps.runTrustGate(options.dir);
  await _doctorDeps.precheckCommand({ dir: options.dir, json: options.json, light: true } satisfies PrecheckOptions);
}
