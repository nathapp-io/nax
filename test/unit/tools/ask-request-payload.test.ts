import { describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { buildCodingToolSupport } from "@/agents/coding-tool-support";
import type { AskRequest } from "@/permissions";

const LONG = `echo ${"x".repeat(400)}`;

function capturingResolver(sink: AskRequest[]) {
  return {
    resolve: (req: AskRequest) => {
      sink.push(req);
      return Promise.resolve({ decision: "deny" as const, decidedBy: "human" as const, latencyMs: 0 });
    },
  };
}

describe("AskRequest payload", () => {
  test("carries the command VERBATIM, not the 200-char summary", async () => {
    // `compileToolPolicy` realpaths the root (macOS /var -> /private/var), so
    // the test must compare like with like; on Linux realpath is a no-op.
    const root = realpathSync(makeTempDir("ask-payload-"));
    mkdirSync(join(root, ".git"), { recursive: true });
    writeFileSync(join(root, ".git", "config"), "[core]\n");
    const seen: AskRequest[] = [];
    const support = buildCodingToolSupport({
      root,
      declared: ["Bash"],
      grants: [{ tool: "Bash", patterns: ["echo *"] }],
      askRules: [{ tool: "Bash", patterns: ["echo *"] }],
      bashApproval: "gated",
      askResolver: capturingResolver(seen),
    });
    await support?.runtime.callTool("Bash", { command: LONG });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.command).toBe(LONG);
    expect(seen[0]?.command?.length).toBeGreaterThan(200);
    expect(seen[0]?.root).toBe(root);
    cleanupTempDir(root);
  });
});
