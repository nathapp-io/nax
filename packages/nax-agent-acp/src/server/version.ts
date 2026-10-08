/**
 * The package version. `package.json` sits two directories above this module in
 * both layouts that run it: `src/server/` (workspace, bun) and `dist/server/`
 * (published package, Node).
 */
import { createRequire } from "node:module";
import { NaxError } from "@nathapp/nax-agent";

const requireJson = createRequire(import.meta.url);

export function packageVersion(): string {
  const manifest: unknown = requireJson("../../package.json");
  if (typeof manifest === "object" && manifest !== null && "version" in manifest) {
    const { version } = manifest;
    if (typeof version === "string") return version;
  }
  throw new NaxError("nax-agent-acp package.json has no version", "ACP_SERVER_NO_VERSION", { stage: "acp-server" });
}
