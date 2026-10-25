import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createCommandLauncher, DISABLED_SANDBOX_STATE } from "#src/sandbox/index";
import type { BashToolOptions } from "#src/tools/bash";
import { _bashToolDeps, createBashTool } from "#src/tools/index";
import { cleanupTempDir, makeFakeSandboxBackend, makeTempDir, withDepsRestore } from "#test/helpers/index";

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

  // US-003: the same byte-identical rule for the new option, across every
  // description variant rather than just `raw`. Off is indistinguishable from
  // absent; on appends exactly one sentence and changes nothing else.
  const UNSANDBOXED_SENTENCE =
    'Set "unsandboxed": true with an "unsandboxedReason" only when the command needs the network, a local socket or a device the sandbox blocks.';
  const descriptionCases: Array<{ label: string; make: () => BashToolOptions }> = [
    { label: "gated without a launcher", make: () => ({ bashApproval: "gated", patterns: ["bun *"] }) },
    {
      label: "gated with a disabled launcher",
      make: () => ({ bashApproval: "gated", launcher: createCommandLauncher({ state: DISABLED_SANDBOX_STATE }) }),
    },
    {
      label: "gated with an available launcher",
      make: () => ({
        bashApproval: "gated",
        patterns: ["bun *"],
        launcher: createCommandLauncher({ state: available, backend: makeFakeSandboxBackend(), policyFor }),
      }),
    },
    {
      label: "gated with an unavailable launcher",
      make: () => ({
        bashApproval: "gated",
        launcher: createCommandLauncher({ state: { kind: "unavailable", backend: "srt", reason: "no bwrap" } }),
      }),
    },
    { label: "escalate with a reachable human", make: () => ({ bashApproval: "escalate", humanApproval: true }) },
    { label: "raw without a launcher", make: () => ({ bashApproval: "raw" }) },
    {
      label: "raw with an available launcher",
      make: () => ({
        bashApproval: "raw",
        launcher: createCommandLauncher({ state: available, backend: makeFakeSandboxBackend(), policyFor }),
      }),
    },
    {
      label: "raw with an unavailable launcher",
      make: () => ({
        bashApproval: "raw",
        launcher: createCommandLauncher({ state: { kind: "unavailable", backend: "srt", reason: "no bwrap" } }),
      }),
    },
  ];

  test.each(descriptionCases)(
    "US-003: unsandboxedCommands off leaves the description unchanged ($label)",
    ({ make }) => {
      expect(createBashTool({ ...make(), unsandboxedCommands: false }).description).toBe(
        createBashTool(make()).description,
      );
    },
  );

  test.each(descriptionCases)(
    "US-003: unsandboxedCommands on appends exactly the one sentence ($label)",
    ({ make }) => {
      const base = createBashTool(make()).description;
      const withOption = createBashTool({ ...make(), unsandboxedCommands: true }).description;
      expect(withOption.startsWith(base)).toBe(true);
      // Either the base ended on a space (most variants do) or a separator was added.
      expect([UNSANDBOXED_SENTENCE, ` ${UNSANDBOXED_SENTENCE}`]).toContain(withOption.slice(base.length));
    },
  );

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
      sandbox: { backend: "srt", wrapped: true, argv: ["/bin/sh", "-c", "export NAX_SANDBOXED=1; echo hi"] },
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

// US-006: the platform seam decides whether a description carries the macOS ps
// note. It is patched through `_bashToolDeps`, never the global
// `process.platform`, so the assertions hold on every host the suite runs on.
describe("US-006 — the darwin ps note in the Bash description", () => {
  withDepsRestore(_bashToolDeps, ["platform"]);

  const DARWIN_PS_SENTENCE =
    'On macOS the sandbox also refuses ps and other setuid programs ("Operation not permitted"), so a test that shells out to ps fails here for that reason alone.';

  const launcher = () => createCommandLauncher({ state: available, backend: makeFakeSandboxBackend(), policyFor });

  test("AC-9: a gated darwin description ends with the ps note", () => {
    _bashToolDeps.platform = () => "darwin";
    const description = createBashTool({
      bashApproval: "gated",
      patterns: ["bun *"],
      launcher: launcher(),
    }).description;
    expect(description).toEndWith(DARWIN_PS_SENTENCE);
  });

  test("AC-10: a gated linux description keeps today's closing sentence", () => {
    _bashToolDeps.platform = () => "linux";
    const description = createBashTool({
      bashApproval: "gated",
      patterns: ["bun *"],
      launcher: launcher(),
    }).description;
    expect(description).toEndWith("-- that is the sandbox, not a bug in your command.");
    expect(description).not.toContain("refuses ps");
  });

  test("AC-11: a raw darwin description names the ps note", () => {
    _bashToolDeps.platform = () => "darwin";
    const description = createBashTool({ bashApproval: "raw", launcher: launcher() }).description;
    expect(description).toContain(DARWIN_PS_SENTENCE);
  });

  test("AC-13: an unavailable raw sandbox keeps the refusal and never advertises the ps note", () => {
    _bashToolDeps.platform = () => "darwin";
    const description = createBashTool({
      bashApproval: "raw",
      launcher: createCommandLauncher({ state: { kind: "unavailable", backend: "srt", reason: "no bwrap" } }),
    }).description;
    expect(description).toContain("sandbox unavailable (no bwrap)");
    expect(description).toContain("every call is refused");
    expect(description).not.toContain(DARWIN_PS_SENTENCE);
  });
});
