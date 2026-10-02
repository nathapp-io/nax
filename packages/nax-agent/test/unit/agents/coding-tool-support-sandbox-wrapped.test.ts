/**
 * US-002: the sandbox state must reach the RAW bash screen through
 * `buildCodingToolSupport`.
 *
 * An available launcher means the command really does run inside the OS
 * sandbox, so a PRD the agent only READS through Bash is no longer refused. A
 * disabled launcher -- no sandbox at all -- keeps refusing it, because a
 * read-only PRD mention is not the reason the screen exists; an unbounded
 * filesystem walk and an unprotected write are.
 *
 * Driven through `buildCodingToolSupport -> runtime.callTool`, like
 * test/integration/permissions/sandbox-wiring.test.ts, but with a STUB
 * launcher so nothing is ever spawned: "allowed" is observed as the tool
 * actually running, "denied" as the call never reaching the launcher.
 */
import { describe, expect, test } from "bun:test";
import { buildCodingToolSupport } from "#src/coding-tools/coding-tool-support";
import type { CommandLauncher, LaunchRequest, SandboxState } from "#src/sandbox/index";
import { DISABLED_SANDBOX_STATE } from "#src/sandbox/index";
import { cleanupTempDir, makeTempDir } from "#test/helpers/index";

const READ_PRD = "git diff .nax/features/f/prd.json";
const WRITE_PRD = "echo x > .nax/features/f/prd.json";

/** A launcher that records the calls it was asked to run instead of running them. */
function stubLauncher(state: SandboxState): { launcher: CommandLauncher; runs: LaunchRequest[] } {
  const runs: LaunchRequest[] = [];
  return {
    runs,
    launcher: {
      state,
      run: async (req) => {
        runs.push(req);
        return {
          exitCode: 0,
          stdout: "",
          stderr: "",
          timedOut: false,
          executed: req.spec.kind === "shell" ? [req.spec.shell, "-c", req.spec.command] : req.spec.argv,
          sandbox: { backend: "none", wrapped: false },
        };
      },
    },
  };
}

function supportAt(root: string, launcher: CommandLauncher) {
  const support = buildCodingToolSupport({
    root,
    declared: ["Bash"],
    grants: [{ tool: "Bash", patterns: ["*"] }],
    bashApproval: "raw",
    launcher,
  });
  if (support === undefined) throw new Error("expected coding-tool support for a raw Bash grant");
  return support;
}

describe("buildCodingToolSupport — raw Bash and the sandbox-wrapped screen (US-002)", () => {
  test("AC16: raw + an available launcher allows reading the feature PRD through Bash", async () => {
    const root = makeTempDir("raw-sbx-wrapped-");
    try {
      const { launcher, runs } = stubLauncher({ kind: "available", backend: "srt", network: "open" });
      const out = await supportAt(root, launcher).runtime.callTool("Bash", { command: READ_PRD });
      expect(out.kind).toBe("ok");
      expect(runs).toHaveLength(1);
    } finally {
      cleanupTempDir(root);
    }
  });

  test("AC16 boundary: raw + an available launcher still refuses a REDIRECT into the PRD", async () => {
    const root = makeTempDir("raw-sbx-wrapped-");
    try {
      const { launcher, runs } = stubLauncher({ kind: "available", backend: "srt", network: "open" });
      const out = await supportAt(root, launcher).runtime.callTool("Bash", { command: WRITE_PRD });
      expect(out.kind).toBe("denied");
      if (out.kind === "denied") expect(out.reason).toContain("Reading it through Bash is allowed");
      expect(runs).toHaveLength(0);
    } finally {
      cleanupTempDir(root);
    }
  });

  test("AC17: raw + a disabled launcher refuses reading the feature PRD through Bash", async () => {
    const root = makeTempDir("raw-sbx-wrapped-");
    try {
      const { launcher, runs } = stubLauncher(DISABLED_SANDBOX_STATE);
      const out = await supportAt(root, launcher).runtime.callTool("Bash", { command: READ_PRD });
      expect(out.kind).toBe("denied");
      if (out.kind === "denied") expect(out.reason).toContain("reads included");
      expect(runs).toHaveLength(0);
    } finally {
      cleanupTempDir(root);
    }
  });

  test("AC17 boundary: an absent launcher screens exactly like a disabled one", async () => {
    const root = makeTempDir("raw-sbx-wrapped-");
    try {
      const support = buildCodingToolSupport({
        root,
        declared: ["Bash"],
        grants: [{ tool: "Bash", patterns: ["*"] }],
        bashApproval: "raw",
      });
      const out = await support?.runtime.callTool("Bash", { command: READ_PRD });
      expect(out?.kind).toBe("denied");
      if (out?.kind === "denied") expect(out.reason).toContain("reads included");
    } finally {
      cleanupTempDir(root);
    }
  });
});
