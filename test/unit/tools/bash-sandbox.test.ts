import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanupTempDir, makeFakeSandboxBackend, makeTempDir } from "@test/helpers";
import { createCommandLauncher, DISABLED_SANDBOX_STATE } from "@/sandbox";
import { createBashTool } from "@/tools";

let root: string;
beforeEach(() => {
  root = makeTempDir("bash-sbx-");
});
afterEach(() => cleanupTempDir(root));

const ctx = () => ({ root, resolvedPaths: [], maxBytes: 40_000, maxFileBytes: 2_000_000 });
const available = { kind: "available", backend: "srt", network: "open" } as const;
const policyFor = async (r: string) => ({ writeRoots: [r], denyWrite: [], denyRead: [], network: {} });

describe("Bash through the launcher", () => {
  test("disabled launcher: raw description is byte-identical to no launcher", () => {
    const plain = createBashTool({ bashApproval: "raw" }).description;
    const disabled = createBashTool({
      bashApproval: "raw",
      launcher: createCommandLauncher({ state: DISABLED_SANDBOX_STATE }),
    }).description;
    expect(disabled).toBe(plain);
    expect(plain).toContain("paths are NOT contained");
  });

  test("available: raw description drops the uncontained sentence and states the sandbox", () => {
    const tool = createBashTool({
      bashApproval: "raw",
      launcher: createCommandLauncher({ state: available, backend: makeFakeSandboxBackend(), policyFor }),
    });
    expect(tool.description).not.toContain("paths are NOT contained");
    expect(tool.description).toContain("inside an OS sandbox");
    expect(tool.description).toContain("network access is unrestricted");
    expect(tool.description).toContain("that screen is advisory");
  });

  test("unavailable + raw: the description says Bash is refused and why", () => {
    const tool = createBashTool({
      bashApproval: "raw",
      launcher: createCommandLauncher({ state: { kind: "unavailable", backend: "srt", reason: "no bwrap" } }),
    });
    expect(tool.description).toContain("sandbox unavailable (no bwrap)");
    expect(tool.description).toContain("every call is refused");
  });

  test("gated: available appends the sandbox sentence; unavailable says not sandboxed", () => {
    const on = createBashTool({
      bashApproval: "gated",
      patterns: ["bun *"],
      launcher: createCommandLauncher({ state: available, backend: makeFakeSandboxBackend(), policyFor }),
    });
    expect(on.description).toContain("Commands that pass run inside an OS sandbox");
    const off = createBashTool({
      bashApproval: "gated",
      patterns: ["bun *"],
      launcher: createCommandLauncher({ state: { kind: "unavailable", backend: "srt", reason: "no bwrap" } }),
    });
    expect(off.description).toContain("Commands are NOT sandboxed on this machine (no bwrap).");
  });

  test("run: goes through the launcher and carries the sandbox record on audit", async () => {
    const backend = makeFakeSandboxBackend();
    const tool = createBashTool({ launcher: createCommandLauncher({ state: available, backend, policyFor }) });
    const r = await tool.run({ command: "echo hi" }, ctx());
    expect(r.content).toContain("exit 0");
    expect(r.audit).toEqual({ executed: ["/bin/sh", "-c", "echo hi"], sandbox: { backend: "srt", wrapped: true } });
    expect(backend.calls[0]?.cwd).toBe(root);
  });

  test("run: a wrap failure is a tool error naming the sandbox", async () => {
    const tool = createBashTool({
      launcher: createCommandLauncher({ state: available, backend: makeFakeSandboxBackend("throw"), policyFor }),
    });
    const r = await tool.run({ command: "touch x" }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content).toContain("[sandbox] could not wrap the command");
    expect(await Bun.file(`${root}/x`).exists()).toBe(false);
  });
});
