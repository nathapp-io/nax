import { scanConfigSecrets } from "../config";
import type { Check } from "./types";

/** Injectable scanner seam for the config-secret precheck. */
export const _configSecretsCheckDeps = { scanConfigSecrets };

/** Report literal secrets in project config without exposing their values. */
export async function checkConfigSecrets(workdir: string): Promise<Check> {
  try {
    const scan = await _configSecretsCheckDeps.scanConfigSecrets(workdir);
    const message = scan.clean
      ? "No literal secrets found in nax config files"
      : scan.findings
          .map(({ file, pointer, kind }) =>
            kind === "unscannable"
              ? `${file} could not be read or parsed as JSON.`
              : `${file}${pointer} (${kind}). Move the value into an environment-variable reference or into the global ~/.nax/config.json (which agents cannot reach).`,
          )
          .join(" ");
    return { name: "config-secrets", tier: "warning", passed: scan.clean, message };
  } catch {
    return {
      name: "config-secrets",
      tier: "warning",
      passed: false,
      message: "Config could not scan nax config files for secrets",
    };
  }
}
