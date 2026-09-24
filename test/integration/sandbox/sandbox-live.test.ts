/**
 * P4 live suite: REAL srt, through the production seam
 * (resolveSessionSandbox -> buildCodingToolSupport -> runtime.callTool),
 * asserting what landed on disk -- never a verdict alone.
 *
 * Skipped, with the probe's reason in the describe title, when the sandbox is
 * unavailable here. With NAX_SANDBOX_REQUIRED=1 (CI) unavailable is a FAILURE,
 * so the suite can never pass by skipping where it is supposed to run.
 *
 * srt's SandboxManager is one per process and `bun test` shares one process
 * across files: this file uses ONLY the registry's backend (one instance) and
 * resets it in afterAll.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir, waitForCondition, withDepsRestore } from "@test/helpers";
import { _sessionSandboxDeps, resolveSessionSandbox } from "@/agents/coding-tool-sandbox";
import { buildCodingToolSupport } from "@/agents/coding-tool-support";
import { DEFAULT_SANDBOX_CONFIG } from "@/config/schemas-sandbox";
import { _resetSandboxRegistryForTests, probeSandboxOnce, resetSandboxBackend, sandboxBackendFor } from "@/sandbox";

const CONFIG = { ...DEFAULT_SANDBOX_CONFIG, enabled: true };
const probe = await probeSandboxOnce(sandboxBackendFor(CONFIG));
const REQUIRED = process.env.NAX_SANDBOX_REQUIRED === "1";
const label = probe.available ? "available" : `SKIPPED: ${probe.reason}`;

if (!probe.available && REQUIRED) {
  test("the sandbox must be available where NAX_SANDBOX_REQUIRED=1", () => {
    throw new Error(`sandbox unavailable in a required environment: ${probe.reason}`);
  }, 30_000);
}

function git(args: string[], cwd: string): string {
  const r = Bun.spawnSync(["git", "-c", "user.email=a@b", "-c", "user.name=a", ...args], { cwd });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return r.stdout.toString();
}

describe.skipIf(!probe.available)(`live sandbox (${label})`, () => {
  withDepsRestore(_sessionSandboxDeps, ["tempRoots", "homedir"]);
  let base: string;
  let root: string;
  let outside: string;
  let home: string;

  beforeEach(() => {
    // Under os.tmpdir(): on macOS that is /var/folders -> /private/var, so a
    // not-yet-existing deny is exercised through a symlinked spelling
    // (Review Focus 2).
    base = makeTempDir("sbx-live-");
    root = join(base, "repo");
    outside = join(base, "outside");
    home = join(base, "home");
    for (const d of [root, outside, home, join(base, "tmp"), join(root, ".nax", "features", "f1")]) {
      mkdirSync(d, { recursive: true });
    }
    writeFileSync(join(root, ".nax", "config.json"), "{}\n");
    // The session's temp root is a PRIVATE dir, so the rest of the system
    // temp dir -- where `outside` lives -- is outside every write root.
    _sessionSandboxDeps.tempRoots = () => [join(base, "tmp")];
    _sessionSandboxDeps.homedir = () => home;
  });
  afterEach(() => cleanupTempDir(base));
  afterAll(async () => {
    await resetSandboxBackend();
    _resetSandboxRegistryForTests();
  });

  async function bash(opts: { root?: string; outputDir?: string; stripEnvVars?: string[] } = {}) {
    const r = opts.root ?? root;
    const launcher = await resolveSessionSandbox({
      config: CONFIG,
      root: r,
      ...(opts.outputDir !== undefined ? { outputDir: opts.outputDir } : {}),
      needsLauncher: true,
    });
    const support = buildCodingToolSupport({
      root: r,
      declared: ["Read", "Bash"],
      grants: [{ tool: "Read", patterns: ["*"] }],
      bashApproval: "raw",
      launcher,
      ...(opts.stripEnvVars !== undefined ? { stripEnvVars: opts.stripEnvVars } : {}),
    });
    if (support === undefined) throw new Error("no coding-tool support");
    return async (command: string, timeoutMs?: number) => {
      const out = await support.runtime.callTool("Bash", {
        command,
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      });
      return { kind: out.kind, content: "content" in out ? String(out.content) : "" };
    };
  }

  test("a write inside the root lands; a write outside does not", async () => {
    const run = await bash();
    await run(`echo in > in.txt; echo out > ${outside}/leak.txt`);
    expect(existsSync(join(root, "in.txt"))).toBe(true);
    expect(existsSync(join(outside, "leak.txt"))).toBe(false);
  }, 30_000);

  test("D13a gap 3 composite: an unmodellable cd into .nax cannot overwrite config.json", async () => {
    const run = await bash();
    await run("cd -P .nax && echo PWNED > config.json");
    expect(readFileSync(join(root, ".nax", "config.json"), "utf8")).toBe("{}\n");
  }, 30_000);

  test("a prd.json in a feature dir created AFTER the session started is protected", async () => {
    const run = await bash();
    mkdirSync(join(root, ".nax", "features", "f2"), { recursive: true });
    writeFileSync(join(root, ".nax", "features", "f2", "prd.json"), "{}");
    await run("echo PWNED > .nax/features/f2/prd.json");
    expect(readFileSync(join(root, ".nax", "features", "f2", "prd.json"), "utf8")).toBe("{}");
  }, 30_000);

  test("Review Focus 3: approvals.json under an outputDir INSIDE a write root stays unwritable", async () => {
    const outputDir = join(home, ".cache", "nax");
    mkdirSync(outputDir, { recursive: true });
    const approvals = join(outputDir, "approvals.json");
    writeFileSync(approvals, "[]");
    const run = await bash({ outputDir });
    await run(`echo forged > ${approvals}; echo ok > ${join(home, ".cache", "other.txt")}`);
    expect(readFileSync(approvals, "utf8")).toBe("[]");
    // the cache root itself IS writable -- the deny is specific, not a missing root
    expect(existsSync(join(home, ".cache", "other.txt"))).toBe(true);
  }, 30_000);

  test("F6 / Review Focus 1: a stripped secret is empty inside the sandbox", async () => {
    process.env.NAX_P4_FAKE_SECRET = "s3cret";
    try {
      const run = await bash({ stripEnvVars: ["NAX_P4_FAKE_SECRET"] });
      const out = await run('echo "[$NAX_P4_FAKE_SECRET]"');
      expect(out.content).toContain("[]");
      expect(out.content).not.toContain("s3cret");
    } finally {
      delete process.env.NAX_P4_FAKE_SECRET;
    }
  }, 30_000);

  test("F2 + finding 4: from a worktree, commits work; hooks, config and the .git pointer are unwritable", async () => {
    git(["init", "-q", "-b", "main"], root);
    writeFileSync(join(root, "seed.txt"), "seed");
    git(["add", "-A"], root);
    git(["commit", "-qm", "seed"], root);
    git(["worktree", "add", "-q", ".nax-wt/US-001", "-b", "wt-us-001"], root);
    const wt = join(root, ".nax-wt", "US-001");
    const configBefore = readFileSync(join(root, ".git", "config"), "utf8");
    const pointerBefore = readFileSync(join(wt, ".git"), "utf8");

    const run = await bash({ root: wt });
    await run(
      'echo w > w.txt && git -c user.email=a@b -c user.name=a add w.txt && git -c user.email=a@b -c user.name=a commit -qm "p4 live commit"',
    );
    expect(git(["log", "--oneline", "wt-us-001"], root)).toContain("p4 live commit");

    await run(`echo 'echo HOOKED' > ${join(root, ".git", "hooks", "pre-commit")}`);
    await run(`echo '[core]' >> ${join(root, ".git", "config")}`);
    await run("echo 'gitdir: /tmp/elsewhere' > .git");
    expect(existsSync(join(root, ".git", "hooks", "pre-commit"))).toBe(false);
    expect(readFileSync(join(root, ".git", "config"), "utf8")).toBe(configBefore);
    expect(readFileSync(join(wt, ".git"), "utf8")).toBe(pointerBefore);
  }, 30_000);

  test("#2198: a commondir redirect never survives the command; sibling worktree pointers are unwritable", async () => {
    git(["init", "-q", "-b", "main"], root);
    writeFileSync(join(root, "seed.txt"), "seed");
    git(["add", "-A"], root);
    git(["commit", "-qm", "seed"], root);
    git(["worktree", "add", "-q", ".nax-wt/US-002", "-b", "wt-us-002"], root);
    const sibling = join(root, ".git", "worktrees", "US-002");
    const siblingBefore = readFileSync(join(sibling, "commondir"), "utf8");
    const pointerBefore = readFileSync(join(root, ".nax-wt", "US-002", ".git"), "utf8");

    const run = await bash();
    // git inside the sandbox still works: no empty commondir stub was mounted
    await run("git -c user.email=a@b -c user.name=a commit -q --allow-empty -m inside");
    expect(git(["log", "--oneline"], root)).toContain("inside");

    await run(`mkdir -p evil && echo "${join(root, "evil")}" > .git/commondir`);
    await run(`echo /tmp/elsewhere > ${join(sibling, "commondir")}`);
    await run("echo 'gitdir: /tmp/elsewhere' > .nax-wt/US-002/.git");
    expect(existsSync(join(root, ".git", "commondir"))).toBe(false);
    expect(readFileSync(join(sibling, "commondir"), "utf8")).toBe(siblingBefore);
    expect(readFileSync(join(root, ".nax-wt", "US-002", ".git"), "utf8")).toBe(pointerBefore);
  }, 30_000);

  test("a timeout kills sandboxed grandchildren", async () => {
    const run = await bash();
    const out = await run("sleep 4711 & sleep 4711 & wait", 1000);
    expect(out.content).toContain("timed out");
    const survivors = () =>
      Bun.spawnSync(["/bin/sh", "-c", "ps -e -o args | grep 'sleep 4711' | grep -v grep || true"])
        .stdout.toString()
        .trim();
    // Rejects (fails the test) if any survivor outlives 3 s.
    await waitForCondition(() => survivors() === "", 3_000, 50);
  }, 30_000);

  test("the likely-denial note reaches the tool result", async () => {
    const run = await bash();
    const out = await run(`echo x > ${outside}/y.txt`);
    expect(out.content).toContain("note: this command ran in the nax sandbox");
  }, 30_000);

  test("the resolved spelling is what the policy used (symlinked temp parent)", async () => {
    // makeTempDir returns the UNRESOLVED spelling; the deny must still hold.
    const run = await bash();
    mkdirSync(join(root, ".nax", "features", "f3"), { recursive: true });
    await run("echo PWNED > .nax/features/f3/prd.json");
    expect(existsSync(join(root, ".nax", "features", "f3", "prd.json"))).toBe(false);
  }, 30_000);
});
