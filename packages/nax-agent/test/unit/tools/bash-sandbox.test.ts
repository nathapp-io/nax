import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createCommandLauncher, DISABLED_SANDBOX_STATE } from "#src/sandbox/index";
import { createBashTool } from "#src/tools/index";
import { cleanupTempDir, makeFakeSandboxBackend, makeTempDir } from "#test/helpers/index";

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
    expect(tool.description).toContain("That screen is advisory");
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
    expect(r.audit).toEqual({
      executed: ["/bin/sh", "-c", "echo hi"],
      sandbox: { backend: "srt", wrapped: true, argv: ["/bin/sh", "-c", "echo hi"] },
      exitCode: 0,
    });
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
    // The catch path carries no audit, so the row can never claim an exit code.
    expect("audit" in r).toBe(false);
  });
});

// US-003: a confined session's sandbox writes only under the run's own temp
// root, so the description must not keep advertising "the system temp
// directories" -- an agent that believes /tmp is writable wastes a turn on a
// denied write. Both available-state call sites (raw and policy-gated) carry
// the confined wording; a shared-temp launcher keeps the legacy sentence.
describe("US-003 — Bash description names the confined temp root", () => {
  const launcherFor = (confined: boolean) =>
    createCommandLauncher({
      state: confined
        ? { kind: "available", backend: "srt", network: "open", sharedTmp: false }
        : { kind: "available", backend: "srt", network: "open" },
      backend: makeFakeSandboxBackend(),
      policyFor,
    });

  test.each([{ bashApproval: "raw" as const }, { bashApproval: "gated" as const }])(
    "US-003 AC5: sharedTmp:false names this run's temp directory ($bashApproval)",
    ({ bashApproval }) => {
      const tool = createBashTool({ bashApproval, patterns: ["bun *"], launcher: launcherFor(true) });
      expect(tool.description).toContain("this run's temp directory ($TMPDIR)");
      expect(tool.description).not.toContain("the system temp directories");
    },
  );

  test("US-003 AC5 boundary: a shared-temp launcher keeps the pre-change wording", () => {
    const tool = createBashTool({ bashApproval: "gated", patterns: ["bun *"], launcher: launcherFor(false) });
    expect(tool.description).toContain("the system temp directories");
    expect(tool.description).not.toContain("this run's temp directory ($TMPDIR)");
  });
});
