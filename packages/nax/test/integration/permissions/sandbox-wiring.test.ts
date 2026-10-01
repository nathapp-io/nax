/**
 * P4 wiring through buildCodingToolSupport -> runtime.callTool, with a FAKE
 * backend (real enforcement is the live suite's job). Asserts executed
 * outcomes -- was the canary written? -- not verdicts alone.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeFakeSandboxBackend, makeTempDir } from "@test/helpers";
import { buildCodingToolSupport } from "@/agents/coding-tool-support";
import type { BashApprovalMode } from "@/config/bash-approval";
import { type CommandLauncher, createCommandLauncher, rawBashRefusalReason } from "@/sandbox";
import { realOrRaw } from "@/utils/realpath";

let root: string;
beforeEach(() => {
  root = makeTempDir("sbx-wiring-");
});
afterEach(() => cleanupTempDir(root));

const unavailable = () => createCommandLauncher({ state: { kind: "unavailable", backend: "srt", reason: "no bwrap" } });
const policyFor = async (r: string) => ({ writeRoots: [r], denyWrite: [], denyRead: [], network: {} });

function session(bashApproval: BashApprovalMode, launcher: CommandLauncher, allow: string[] = ["*"]) {
  const support = buildCodingToolSupport({
    root,
    declared: ["Read", "Bash"],
    grants: [
      { tool: "Read", patterns: ["*"] },
      { tool: "Bash", patterns: allow },
    ],
    bashApproval,
    launcher,
  });
  if (support === undefined) throw new Error("no support");
  return support;
}

describe("sandbox wiring (production seam)", () => {
  test("raw + unavailable: refused with the reason, and nothing ran", async () => {
    const support = session("raw", unavailable());
    const out = await support.runtime.callTool("Bash", { command: "echo hi > canary.txt" });
    expect(out.kind).toBe("denied");
    // toStartWith: the runtime may append a " -- <redirect>" to any denial (runtime.ts:456-465).
    if (out.kind === "denied") expect(out.reason).toStartWith(rawBashRefusalReason("no bwrap"));
    expect(existsSync(join(root, "canary.txt"))).toBe(false);
  });

  test("raw + unavailable: the advertised Bash description says so", () => {
    const bash = session("raw", unavailable()).tools.find((t) => t.name === "Bash");
    expect(bash?.description).toContain("sandbox unavailable (no bwrap)");
  });

  test("gated + unavailable: an allowed command runs unwrapped", async () => {
    const support = session("gated", unavailable(), ["echo *"]);
    const out = await support.runtime.callTool("Bash", { command: "echo hi" });
    expect(out.kind).toBe("ok");
  });

  test("raw + available: runs through the backend at the root", async () => {
    const backend = makeFakeSandboxBackend("enforce");
    const launcher = createCommandLauncher({
      state: { kind: "available", backend: "srt", network: "open" },
      backend,
      policyFor,
    });
    const out = await session("raw", launcher).runtime.callTool("Bash", { command: "echo hi > canary.txt" });
    expect(out.kind).toBe("ok");
    expect(existsSync(join(root, "canary.txt"))).toBe(true);
    // ctx.root arrives realpath-resolved (compileToolPolicy -> realOrRaw): /var -> /private/var on macOS.
    expect(backend.calls[0]?.cwd).toBe(realOrRaw(root));
  });

  test("D14: a declared RunCommand command never reaches the launcher", async () => {
    const backend = makeFakeSandboxBackend("enforce");
    const launcher = createCommandLauncher({
      state: { kind: "available", backend: "srt", network: "open" },
      backend,
      policyFor,
    });
    const support = buildCodingToolSupport({
      root,
      declared: ["RunCommand"],
      grants: [{ tool: "RunCommand", patterns: ["*"] }],
      declaredCommands: new Map([["hello", "echo hi"]]),
      bashApproval: "raw",
      launcher,
    });
    const out = await support?.runtime.callTool("RunCommand", { command: "hello" });
    expect(out?.kind).toBe("ok");
    expect(backend.calls).toHaveLength(0);
  });
});
