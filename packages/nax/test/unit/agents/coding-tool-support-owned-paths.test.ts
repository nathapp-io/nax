/**
 * S3-2 characterization: nax's owned-path refusals, end to end through the real
 * dispatch entry. Written before the OwnedPathsPolicy port exists and kept
 * green through the move: if nax ever stops injecting its OwnedPathsPolicy,
 * the nax-agent default (no owned paths) makes every one of these writable and
 * this fails.
 *
 * Adapted from the brief's draft in three places (rulings in task-1-report.md):
 * - Exec is not a registered tool (its argv branch runs under RunCommand), so
 *   the positional-path case calls RunCommand with `argv`.
 * - The argv positional-path conflict surfaces as kind "error" (isError tool
 *   result from normalizeExec), not kind "denied".
 * - "RunCommand" joins declaredTools so the argv branch is reachable.
 *
 * US-003 (config read gate): reads of a nax config file are now admitted when
 * the config-secret scan is clean and the dispatch's Bash runs in `raw`
 * approval mode (or declares no Bash at all). The three cases that relied on
 * the old blanket refusal -- Read of the root config, Glob through a symlink to
 * it, and Exec's positional-path screen -- are re-pinned here against a config
 * that HOLDS a literal secret, so the refusal they assert is the gate's, not a
 * coincidence. Every write refusal is unchanged.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { _resetSandboxRegistryForTests, type CodingToolName } from "@nathapp/nax-agent/internal";
import { cleanupTempDir, makeNaxConfig, makeTempDir } from "@test/helpers";
import { _codingToolSupportDeps, resolveCodingToolSupport } from "@/agents/coding-tool-support-resolve";

let root: string;
beforeEach(() => {
  root = makeTempDir("nax-owned-paths-");
  mkdirSync(join(root, ".nax", "features", "f"), { recursive: true });
  writeFileSync(join(root, ".nax", "config.json"), "{}");
  writeFileSync(join(root, ".nax", "features", "f", "prd.json"), "{}");
  writeFileSync(join(root, ".queue.txt"), "");
});
afterEach(() => {
  cleanupTempDir(root);
  _resetSandboxRegistryForTests();
});

const DECLARED: readonly CodingToolName[] = ["Read", "Write", "Bash", "Glob", "Exec", "RunCommand"];

/** The literal header the US-003 fixtures use to make the scan report a finding. */
const LITERAL_HEADER = "Bearer abc12345xyz";

/** US-003: a config that is NOT clean, so the read gate stays closed. */
function dirtyRootConfig(): void {
  writeFileSync(
    join(root, ".nax", "config.json"),
    JSON.stringify({ reporters: { webhook: { headers: { Authorization: LITERAL_HEADER } } } }),
  );
}

function rootConfigContents(): string {
  return readFileSync(join(root, ".nax", "config.json"), "utf8");
}

/** The dispatch under test, with only the fields a US-003 case varies. */
async function supportFor(opts: { declaredTools: readonly CodingToolName[]; bashApproval?: "raw" | "gated" }) {
  const execution: Record<string, unknown> = {
    permissionProfile: "unrestricted",
    sandbox: { enabled: false },
    ...(opts.bashApproval !== undefined ? { bashApproval: opts.bashApproval } : {}),
  };
  return await resolveCodingToolSupport({
    declaredTools: opts.declaredTools,
    codingToolRoot: root,
    pipelineStage: "run",
    config: makeNaxConfig({ execution }),
  });
}

async function denialFor(tool: string, input: Record<string, unknown>, bashApproval?: "raw"): Promise<string> {
  const support = await resolveCodingToolSupport({
    declaredTools: DECLARED,
    codingToolRoot: root,
    pipelineStage: "run",
    config: makeNaxConfig({
      execution: {
        permissionProfile: "unrestricted",
        sandbox: { enabled: false },
        ...(bashApproval !== undefined ? { bashApproval } : {}),
      },
    }),
  });
  const outcome = await support?.runtime.callTool(tool, input);
  if (outcome?.kind !== "denied") throw new Error(`expected ${tool} to be denied, got ${outcome?.kind}`);
  return outcome.reason;
}

async function okContent(tool: string, input: Record<string, unknown>): Promise<string> {
  const support = await resolveCodingToolSupport({
    declaredTools: DECLARED,
    codingToolRoot: root,
    pipelineStage: "run",
    config: makeNaxConfig({ execution: { permissionProfile: "unrestricted", sandbox: { enabled: false } } }),
  });
  const outcome = await support?.runtime.callTool(tool, input);
  if (outcome?.kind !== "ok") throw new Error(`expected ${tool} to run, got ${outcome?.kind}`);
  return JSON.stringify(outcome);
}

const CONFIG_REASON =
  'path ".nax/config.json" is one of nax\'s own config files, which every tool is refused regardless of grant -- ' +
  "`quality.commands` and `acceptance.command` are run through a shell WITHOUT passing the permission gate " +
  "because a human wrote them, so editing this file is a route to running an ungated command on the next run";

describe("nax owned paths through resolveCodingToolSupport (S3-2 byte-identity pin)", () => {
  test("Write to the PRD", async () => {
    expect(await denialFor("Write", { path: ".nax/features/f/prd.json", content: "x" })).toBe(
      'Write may not modify ".nax/features/f/prd.json" is nax\'s own run state: it holds the acceptance criteria this story is judged against, so no tool may modify it. Change the code, not the criteria.',
    );
  });

  test("Write to the queue file", async () => {
    expect(await denialFor("Write", { path: ".queue.txt", content: "ABORT" })).toBe(
      'Write may not modify ".queue.txt" is nax\'s own run state: it carries the PAUSE/ABORT/SKIP commands that control this run, so no tool may modify it. Change the run through the queue command, not by writing its file.',
    );
  });

  test("Write to other .nax state", async () => {
    expect(await denialFor("Write", { path: ".nax/features/f/context.md", content: "x" })).toBe(
      "Write may not modify \".nax/features/f/context.md\" is nax's own state, which agents do not modify. Under .nax/, write only to your scratchpad (.nax/scratchpad/) or to a feature's acceptance test file. A human can open a path for a story by listing it in execution.sandbox.filesystem.allowWrite in the project config.",
    );
  });

  test("US-003: Read of a config holding a literal secret is refused with the read-disabled reason", async () => {
    // US-003: this used to assert the blanket refusal on a CLEAN config. With
    // reads open, a clean config is readable; the refusal that survives is the
    // gate's, and it names `nax doctor` as the remedy.
    dirtyRootConfig();
    const reason = await denialFor("Read", { path: ".nax/config.json" });
    expect(reason.startsWith(CONFIG_REASON)).toBe(true);
    expect(reason).toContain("nax doctor");
  });

  test("raw Bash naming the queue file", async () => {
    // `cat` maps to the READ intent, so the runtime appends a redirect to Read
    // (runtime-calltool.ts resolveDenialOutcome, denial-redirect.ts).
    expect(await denialFor("Bash", { command: "cat .queue.txt" }, "raw")).toBe(
      'Bash command names ".queue.txt", which is nax\'s run-control queue. Bash commands naming it are refused, reads included -- change the run through the queue command.' +
        " -- this session already has `Read` -- Read returns file contents, by line range with offset/limit",
    );
  });

  test("raw Bash redirecting into nax config", async () => {
    expect(await denialFor("Bash", { command: "echo x > .nax/config.json" }, "raw")).toBe(
      'Bash command redirects into ".nax/config.json", which is nax configuration. Bash commands naming it are refused, reads included -- nax configuration is not changed from inside a run.',
    );
  });

  test("US-003: Glob does not list a symlink to a config holding a literal secret", async () => {
    // Glob's node runtime never descends into a dot segment, so `.nax/` itself
    // is unlistable regardless of ownership; a symlink named without a dot
    // segment is the only spelling that reaches resolveWithin with a nax-owned
    // target. A symlink to an ordinary file is listed; a symlink to a config
    // the gate keeps closed is discarded by resolveWithin's owned-config branch.
    dirtyRootConfig();
    writeFileSync(join(root, ".nax", "notes.json"), "{}");
    symlinkSync(".nax/notes.json", join(root, "plain.json"));
    symlinkSync(".nax/config.json", join(root, "naxcfg.json"));
    const listed = await okContent("Glob", { pattern: "plain.json" });
    expect(listed).toContain("plain.json");
    const refused = await okContent("Glob", { pattern: "naxcfg.json" });
    expect(refused).toContain("no matches");
  });

  test("US-003: Exec refuses a positional path to a config holding a literal secret", async () => {
    // Exec is the identity of a RunCommand call carrying `argv` (no "Exec"
    // tool is registered), the positional-path screen fires only on
    // path-SHAPED tokens (`./`-prefixed counts; a bare `.nax/...` does not),
    // and the conflict from normalizeExec surfaces as an isError tool result:
    // kind "error". The error text is unchanged from the pre-US-003 assertion;
    // only the fixture (a config the read gate keeps closed) moved.
    dirtyRootConfig();
    const support = await resolveCodingToolSupport({
      declaredTools: DECLARED,
      codingToolRoot: root,
      pipelineStage: "run",
      config: makeNaxConfig({ execution: { permissionProfile: "unrestricted", sandbox: { enabled: false } } }),
    });
    const outcome = await support?.runtime.callTool("RunCommand", { argv: ["bun", "add", "./.nax/config.json"] });
    if (outcome?.kind !== "error") throw new Error(`expected RunCommand(Exec) to error, got ${outcome?.kind}`);
    expect(outcome.content).toContain(
      'argv contains a path-shaped argument "./.nax/config.json" that resolves outside the permitted root',
    );
  });
});

/**
 * US-003 — the config read gate, end to end through `resolveCodingToolSupport`.
 *
 * Reads open only when the config-secret scan is clean AND the dispatch's
 * Bash either is not declared or runs in `raw` approval mode. Every write
 * refusal is unchanged, and a rejected scan fails closed.
 */
describe("US-003 — the native config read gate through resolveCodingToolSupport", () => {
  test("US-003 AC12: a clean config is readable when Bash runs in raw mode", async () => {
    const support = await supportFor({ declaredTools: ["Read", "Bash", "Write"], bashApproval: "raw" });
    const outcome = await support?.runtime.callTool("Read", { path: ".nax/config.json" });
    expect(outcome?.kind).toBe("ok");
    if (outcome?.kind !== "ok") throw new Error("expected Read of the root config to be admitted");
    expect(outcome.content).toContain("{}");
  });

  test("US-003 AC12 (boundary): a clean config is readable when the dispatch declares no Bash at all", async () => {
    // The gate opens for a dispatch that cannot run shell commands in the first
    // place: with no Bash declared there is no ungated-shell route to guard.
    const support = await supportFor({ declaredTools: ["Read"], bashApproval: "gated" });
    const outcome = await support?.runtime.callTool("Read", { path: ".nax/config.json" });
    expect(outcome?.kind).toBe("ok");
  });

  test("US-003 AC12 (boundary): a gated dispatch that DOES declare Bash keeps the read closed", async () => {
    const support = await supportFor({ declaredTools: ["Read", "Bash", "Write"], bashApproval: "gated" });
    const outcome = await support?.runtime.callTool("Read", { path: ".nax/config.json" });
    expect(outcome?.kind).toBe("denied");
  });

  test("US-003 AC13: a config write is refused with the ungated-shell reason and leaves the file alone", async () => {
    const support = await supportFor({ declaredTools: ["Write"] });
    const outcome = await support?.runtime.callTool("Write", { path: ".nax/config.json", content: "x" });
    expect(outcome?.kind).toBe("denied");
    if (outcome?.kind !== "denied") throw new Error("expected Write to the config to be denied");
    expect(outcome.reason).toContain("quality.commands");
    expect(rootConfigContents()).toBe("{}");
  });

  test("US-003 AC14: a scratchpad symlink pointing at the config cannot overwrite it", async () => {
    mkdirSync(join(root, ".nax", "scratchpad"), { recursive: true });
    symlinkSync(join(root, ".nax", "config.json"), join(root, ".nax", "scratchpad", "config-link.json"));
    const support = await supportFor({ declaredTools: ["ScratchpadWrite"] });
    const outcome = await support?.runtime.callTool("ScratchpadWrite", { path: "config-link.json", content: "x" });
    expect(outcome?.kind).toBe("denied");
    expect(rootConfigContents()).toBe("{}");
  });

  test("US-003 AC15: a gated Bash dispatch keeps the config read closed and names nax doctor", async () => {
    const support = await supportFor({ declaredTools: ["Bash", "Read", "Write"], bashApproval: "gated" });
    const outcome = await support?.runtime.callTool("Read", { path: ".nax/config.json" });
    expect(outcome?.kind).toBe("denied");
    if (outcome?.kind !== "denied") throw new Error("expected Read of the root config to be denied under gated Bash");
    expect(outcome.reason).toContain("nax doctor");
  });

  test("US-003 AC16: a gated Bash redirect into the config is refused and the file is untouched", async () => {
    const support = await supportFor({ declaredTools: ["Bash", "Write"], bashApproval: "gated" });
    const outcome = await support?.runtime.callTool("Bash", { command: "echo x > .nax/config.json" });
    expect(outcome?.kind).toBe("denied");
    expect(rootConfigContents()).toBe("{}");
  });

  test("US-003 AC17: a literal header value in the config closes the read and names nax doctor", async () => {
    dirtyRootConfig();
    const support = await supportFor({ declaredTools: ["Read"] });
    const outcome = await support?.runtime.callTool("Read", { path: ".nax/config.json" });
    expect(outcome?.kind).toBe("denied");
    if (outcome?.kind !== "denied") throw new Error("expected Read of the dirty root config to be denied");
    expect(outcome.reason).toContain("nax doctor");
  });

  test("US-003 AC18: a literal header value in a mono package config closes the root read", async () => {
    const packageDir = join(root, ".nax", "mono", "apps", "api");
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(
      join(packageDir, "config.json"),
      JSON.stringify({ reporters: { webhook: { headers: { Authorization: LITERAL_HEADER } } } }),
    );
    const support = await supportFor({ declaredTools: ["Read"] });
    const outcome = await support?.runtime.callTool("Read", { path: ".nax/config.json" });
    expect(outcome?.kind).toBe("denied");
    if (outcome?.kind !== "denied") throw new Error("expected Read of the root config to be denied");
    expect(outcome.reason).toContain("nax doctor");
  });

  test("US-003 AC19: the scan runs exactly once, on the dispatch root", async () => {
    const original = _codingToolSupportDeps.scanConfigSecrets;
    const calls: string[] = [];
    _codingToolSupportDeps.scanConfigSecrets = async (dir: string) => {
      calls.push(dir);
      return { clean: true, files: [], findings: [] };
    };
    try {
      await supportFor({ declaredTools: ["Read"] });
      expect(calls).toEqual([root]);
    } finally {
      _codingToolSupportDeps.scanConfigSecrets = original;
    }
  });

  test("US-003 AC19 (boundary): a dispatch with no tools and no providers never scans", async () => {
    // The empty union returns before `buildCodingToolSupport` is reached, so
    // there is no dispatch to gate and no reason to read anything off disk. A
    // scan placed above that guard would fire on every no-op hop.
    const original = _codingToolSupportDeps.scanConfigSecrets;
    const calls: string[] = [];
    _codingToolSupportDeps.scanConfigSecrets = async (dir: string) => {
      calls.push(dir);
      return { clean: true, files: [], findings: [] };
    };
    try {
      expect(await supportFor({ declaredTools: [] })).toBeUndefined();
      expect(calls).toEqual([]);
    } finally {
      _codingToolSupportDeps.scanConfigSecrets = original;
    }
  });

  test("US-003 AC20: a rejecting scan fails closed without rejecting the dispatch", async () => {
    const original = _codingToolSupportDeps.scanConfigSecrets;
    _codingToolSupportDeps.scanConfigSecrets = async () => {
      throw new Error("scan failed");
    };
    try {
      const support = await supportFor({ declaredTools: ["Read"] });
      expect(support).toBeDefined();
      const outcome = await support?.runtime.callTool("Read", { path: ".nax/config.json" });
      expect(outcome?.kind).toBe("denied");
      if (outcome?.kind !== "denied") throw new Error("expected Read of the root config to be denied");
      expect(outcome.reason).toContain("nax doctor");
    } finally {
      _codingToolSupportDeps.scanConfigSecrets = original;
    }
  });
});
