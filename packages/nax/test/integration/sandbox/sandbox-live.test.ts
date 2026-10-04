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
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type AskResolver, chainAskLinks, createBashTool } from "@nathapp/nax-agent";
import type { BashApprovalMode } from "@nathapp/nax-agent/internal";
import {
  _agentOutputEnvDeps,
  _resetSandboxRegistryForTests,
  _sessionSandboxDeps,
  buildCodingToolSupport,
  createCommandLauncher,
  DEFAULT_SANDBOX_CONFIG,
  LIKELY_SANDBOX_DENIAL,
  probeSandboxOnce,
  resetSandboxBackend,
  resolveSessionSandbox,
  runTmpRoot,
  sandboxBackendFor,
} from "@nathapp/nax-agent/internal";
import { cleanupTempDir, makeTempDir, waitForCondition, withDepsRestore } from "@test/helpers";
import { naxOwnedPathsPolicy } from "@/agents/nax-owned-writes";
import { naxProtectedPaths } from "@/agents/nax-protected-paths";

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
  withDepsRestore(_sessionSandboxDeps, ["tempRoots", "homedir", "commonDirTripwire"]);
  let base: string;
  let root: string;
  let outside: string;
  let home: string;
  let probeCliResult: Promise<{ exitCode: number; stdout: string }> | undefined;

  function runProbeCli(): Promise<{ exitCode: number; stdout: string }> {
    probeCliResult ??= (async () => {
      const proc = Bun.spawn([process.execPath, "bin/nax.ts", "sandbox", "probe", "--json"], {
        cwd: process.cwd(),
        stdout: "pipe",
        stderr: "pipe",
      });
      const stderrRead = new Response(proc.stderr).text();
      const [exitCode, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
      await stderrRead;
      return { exitCode, stdout };
    })();
    return probeCliResult;
  }

  test("US-001 AC21: the CLI subprocess exits successfully when the sandbox is available", async () => {
    const result = await runProbeCli();
    expect(result.exitCode).toBe(0);
  }, 60_000);

  test("US-001 AC22: the CLI subprocess emits an available srt JSON report", async () => {
    const result = await runProbeCli();
    expect(JSON.parse(result.stdout)).toMatchObject({ available: true, backend: "srt" });
  }, 60_000);

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

  async function bash(
    opts: {
      root?: string;
      outputDir?: string;
      stripEnvVars?: string[];
      bashApproval?: BashApprovalMode;
      askResolver?: AskResolver;
      grants?: readonly { tool: string; patterns: readonly string[] }[];
    } = {},
  ) {
    const r = opts.root ?? root;
    const launcher = await resolveSessionSandbox({
      config: CONFIG,
      root: r,
      ...(opts.outputDir !== undefined ? { outputDir: opts.outputDir } : {}),
      needsLauncher: true,
      protectedPaths: naxProtectedPaths(),
      ownedPaths: naxOwnedPathsPolicy,
    });
    const support = buildCodingToolSupport({
      root: r,
      declared: ["Read", "Bash"],
      grants: opts.grants ?? [{ tool: "Read", patterns: ["*"] }],
      bashApproval: opts.bashApproval ?? "raw",
      launcher,
      ...(opts.askResolver !== undefined ? { askResolver: opts.askResolver } : {}),
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

  test("review test gap 2: escalate + human approval does not let a write past the sandbox's protected path", async () => {
    let consulted = 0;
    const run = await bash({
      bashApproval: "escalate",
      // The command must NOT match the grant: a granted command never asks, and
      // a run with no ask cannot prove the human approval happened before the
      // sandbox refused (the grant gate would be the only barrier).
      grants: [{ tool: "Bash", patterns: ["bun test *"] }],
      askResolver: chainAskLinks([
        {
          name: "yes",
          resolve: async () => {
            consulted += 1;
            return { decision: "allow" as const, decidedBy: "human" as const };
          },
        },
      ]),
    });
    await run("cd -P .nax && echo PWNED > config.json");
    // The ask FIRED and the human allowed it: the write was stopped by the
    // wrapped sandbox's denyWrite on .nax/config.json, never by the grant gate.
    expect(consulted).toBe(1);
    expect(readFileSync(join(root, ".nax", "config.json"), "utf8")).toBe("{}\n");
  }, 30_000);

  test("a prd.json in a feature dir created AFTER the session started is protected", async () => {
    const run = await bash();
    mkdirSync(join(root, ".nax", "features", "f2"), { recursive: true });
    writeFileSync(join(root, ".nax", "features", "f2", "prd.json"), "{}");
    await run("echo PWNED > .nax/features/f2/prd.json");
    expect(readFileSync(join(root, ".nax", "features", "f2", "prd.json"), "utf8")).toBe("{}");
  }, 30_000);

  test("#2260: rm -rf .nax and mv .nax leave nax state intact; the scratchpad stays writable", async () => {
    mkdirSync(join(root, ".nax", "rules"), { recursive: true });
    mkdirSync(join(root, ".nax", "scratchpad"), { recursive: true });
    mkdirSync(join(root, ".nax", "features", "f1", "stories", "US-001"), { recursive: true });
    writeFileSync(join(root, ".nax", "rules", "a.md"), "rule");
    writeFileSync(join(root, ".nax", "features", "f1", "stories", "US-001", "manifest.json"), "{}");
    const run = await bash();
    await run("rm -rf .nax; mv .nax .nax-old");
    expect(readFileSync(join(root, ".nax", "rules", "a.md"), "utf8")).toBe("rule");
    expect(existsSync(join(root, ".nax", "features", "f1", "stories", "US-001", "manifest.json"))).toBe(true);
    expect(existsSync(join(root, ".nax-old"))).toBe(false);
    await run("mkdir -p .nax/scratchpad && echo ok > .nax/scratchpad/probe.txt");
    expect(readFileSync(join(root, ".nax", "scratchpad", "probe.txt"), "utf8")).toBe("ok\n");
  }, 30_000);

  test("#2260: an absent .nax/rules cannot be created to plant a rule", async () => {
    const run = await bash();
    await run("mkdir -p .nax/rules && echo planted > .nax/rules/x.md");
    expect(existsSync(join(root, ".nax", "rules", "x.md"))).toBe(false);
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

  test("#2209: in a main checkout, .git cannot be renamed away or replaced by a pointer file", async () => {
    git(["init", "-q", "-b", "main"], root);
    writeFileSync(join(root, "seed.txt"), "seed");
    git(["add", "-A"], root);
    git(["commit", "-qm", "seed"], root);
    const inodeBefore = statSync(join(root, ".git")).ino;
    const agentDir = join(root, "agent-git");

    const run = await bash();
    await run(`mv .git .git-old; mkdir -p ${agentDir}; printf 'gitdir: ${agentDir}\\n' > .git; true`);

    expect(existsSync(join(root, ".git-old"))).toBe(false);
    expect(statSync(join(root, ".git")).isDirectory()).toBe(true);
    expect(statSync(join(root, ".git")).ino).toBe(inodeBefore);
    expect(git(["rev-parse", "--absolute-git-dir"], root).trim()).toBe(realpathSync(join(root, ".git")));
  }, 30_000);

  test("#2211: from a worktree, the common dir's commondir and sibling worktrees never become writable", async () => {
    // No tripwire: the write must fail outright, so there is no window in which
    // a concurrent unsandboxed git could follow a stray commondir.
    _sessionSandboxDeps.commonDirTripwire = async () => undefined;
    git(["init", "-q", "-b", "main"], root);
    writeFileSync(join(root, "seed.txt"), "seed");
    git(["add", "-A"], root);
    git(["commit", "-qm", "seed"], root);
    git(["worktree", "add", "-q", ".nax-wt/US-001", "-b", "wt-us-001"], root);
    git(["worktree", "add", "-q", ".nax-wt/US-002", "-b", "wt-us-002"], root);
    const common = join(root, ".git");
    const siblingHead = join(common, "worktrees", "US-002", "HEAD");
    const siblingHeadBefore = readFileSync(siblingHead, "utf8");

    const run = await bash({ root: join(root, ".nax-wt", "US-001") });
    await run(`echo ${outside} > ${join(common, "commondir")}; echo ref: refs/heads/main > ${siblingHead}; true`);

    expect(existsSync(join(common, "commondir"))).toBe(false);
    expect(readFileSync(siblingHead, "utf8")).toBe(siblingHeadBefore);
    expect(git(["status", "--porcelain", "-uno"], root)).toBe("");
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

  test("US-001: a wrapped background process holding the pipe is killed when the shell exits", async () => {
    const run = await bash();
    const out = await run("sleep 4714 & echo started", 1500);
    expect(out.content).toContain("started");
    const survivors = () =>
      Bun.spawnSync(["/bin/sh", "-c", "ps -e -o args | grep 'sleep 4714' | grep -v grep || true"])
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

  describe("US-002 — the run's own temp root is the only writable temp root", () => {
    /** A run root under this host's resolvable parent, unique to this test. */
    function makeRun() {
      const runId = `us002-${process.pid}-${Date.now()}`;
      const runRoot = runTmpRoot(runId);
      return { runRoot, sessionDir: join(runRoot, "US-002-live") };
    }

    function confinedLauncher(runRoot: string, sessionDir: string) {
      return resolveSessionSandbox({
        config: CONFIG,
        root,
        needsLauncher: true,
        runTmpRoot: runRoot,
        tmpDir: sessionDir,
        protectedPaths: naxProtectedPaths(),
        ownedPaths: naxOwnedPathsPolicy,
      });
    }

    function request(command: string) {
      return {
        spec: { kind: "shell" as const, shell: "/bin/sh", command },
        root,
        cwd: root,
        timeoutMs: 30_000,
        stripEnvVars: [],
      };
    }

    test("US-002 AC21/AC22: a write through the confined $TMPDIR succeeds and lands on disk", async () => {
      const { runRoot, sessionDir } = makeRun();
      try {
        const launcher = await confinedLauncher(runRoot, sessionDir);
        expect(launcher.state.kind).toBe("available");

        const result = await launcher.run(request('echo x > "$TMPDIR/ok.txt"'));

        expect(result.exitCode).toBe(0);
        expect(existsSync(join(sessionDir, "ok.txt"))).toBe(true);
      } finally {
        cleanupTempDir(runRoot);
      }
    }, 60_000);

    test("US-002 AC23/AC24: a write straight into /tmp is refused and leaves nothing behind", async () => {
      const { runRoot, sessionDir } = makeRun();
      // Directly under /tmp, outside the run's own /tmp/nax/<runId> root.
      const stray = `/tmp/nax-us002-${process.pid}-${Date.now()}.txt`;
      try {
        const launcher = await confinedLauncher(runRoot, sessionDir);

        const result = await launcher.run(request(`echo x > ${stray}`));

        expect(result.exitCode).not.toBe(0);
        expect(existsSync(stray)).toBe(false);
      } finally {
        if (existsSync(stray)) rmSync(stray, { force: true });
        cleanupTempDir(runRoot);
      }
    }, 60_000);

    // #2301. srt always allows `/tmp/claude` on macOS regardless of the policy
    // (SANDBOX_OWN_WRITE_PATHS, sandbox-utils.js:477), and it renders its allow
    // rules before its deny rules in a macOS profile
    // (macos-sandbox-utils.js:636 then :654), where the later deny wins — so the
    // deny is the only thing that takes the write back. This is the assertion
    // that proves it: on the unit side we only see the policy nax built.
    test.skipIf(process.platform !== "darwin")(
      "#2301: a write straight into /tmp/claude is refused and leaves nothing behind",
      async () => {
        const { runRoot, sessionDir } = makeRun();
        const stray = `/tmp/claude/nax-2301-${process.pid}-${Date.now()}.txt`;
        try {
          const launcher = await confinedLauncher(runRoot, sessionDir);

          const result = await launcher.run(request(`echo x > ${stray}`));

          expect(result.exitCode).not.toBe(0);
          // The non-zero exit has to be the SANDBOX, not a shell typo or a
          // missing parent directory — `echo x > <path>` also exits non-zero with
          // ENOENT on a well-formed command whose target dir is absent, and the
          // exit code on its own cannot tell the two apart. LIKELY_SANDBOX_DENIAL
          // is the errno pair nax itself matches to call a failure a sandbox
          // denial (launcher.ts:161 computes `denied` from it), so a match is
          // what ties the refusal to the deny rather than to the command's
          // spelling.
          expect(result.stderr).toMatch(LIKELY_SANDBOX_DENIAL);
          // …and on THIS path. Without it, an EPERM raised for some other write
          // would satisfy the line above just as well.
          expect(result.stderr).toContain(stray);
          expect(existsSync(stray)).toBe(false);
        } finally {
          if (existsSync(stray)) rmSync(stray, { force: true });
          cleanupTempDir(runRoot);
        }
      },
      60_000,
    );

    test.skipIf(process.platform !== "darwin")(
      "#2301 boundary: writing through $TMPDIR and a heredoc still work",
      async () => {
        // The deny is specific to srt's own TMPDIR. #2301 asks for a proof that
        // "writes to $TMPDIR and heredocs still work" — the shell's internal temp
        // files follow the same TMPDIR the launcher exports, so a deny broad
        // enough to catch them would break ordinary commands too.
        const { runRoot, sessionDir } = makeRun();
        try {
          const launcher = await confinedLauncher(runRoot, sessionDir);

          // The heredoc write is LAST on purpose. A shell script's exit status is
          // its LAST statement's, so with `echo ok` last the status would be
          // echo's and would stay 0 even when the denied write failed — the exit
          // code would assert nothing. Written this way, exit 0 means the write
          // itself succeeded.
          const result = await launcher.run(request("echo ok\ncat <<'EOF' > \"$TMPDIR/heredoc.txt\"\nbody\nEOF"));

          expect(result.exitCode).toBe(0);
          // Under the SESSION dir, not merely writable somewhere: the launcher's
          // `export TMPDIR=…` prefix (tmpEnvPrefix) is what aims `$TMPDIR` at the
          // session temp dir, and the file landing exactly there is what shows the
          // deny left that path alone rather than blocking the write and letting
          // the shell fall back to some other temp root.
          expect(existsSync(join(sessionDir, "heredoc.txt"))).toBe(true);
        } finally {
          cleanupTempDir(runRoot);
        }
      },
      60_000,
    );
  });

  /**
   * US-004: the `AGENT=1` overlay has to survive the wrap. The launcher's
   * TMPDIR comment claims srt overrides TMPDIR itself while the other `env`
   * overlay keys reach the wrapped child — that claim is what this test
   * actually runs. Real srt, through `createCommandLauncher` and the tool's own
   * spawn path; nothing is stubbed but the marker lookup, which is scoped to
   * this block.
   */
  describe("US-004 — the AGENT=1 overlay reaches a wrapped child", () => {
    withDepsRestore(_agentOutputEnvDeps, ["processEnv"]);

    const markers = ["CLAUDECODE", "REPL_ID", "AGENT"] as const;
    let savedMarkers: Record<string, string | undefined>;

    beforeEach(() => {
      // The suite itself may run from an agent shell — nax sets AGENT=1 for its
      // OWN test runs, which is exactly the behaviour under test here. Clear the
      // markers so AGENT=1 inside the sandbox can only have come from the
      // overlay, never from inheritance.
      savedMarkers = Object.fromEntries(markers.map((m) => [m, process.env[m]]));
      for (const m of markers) delete process.env[m];
      _agentOutputEnvDeps.processEnv = () => ({ PATH: process.env.PATH });
    });

    afterEach(() => {
      for (const m of markers) {
        const value = savedMarkers[m];
        if (value === undefined) delete process.env[m];
        else process.env[m] = value;
      }
    });

    test("US-004 AC13: an available srt-backed launcher runs the command with AGENT=1 in its env", async () => {
      // The registry hands back the process's one createSrtBackend() instance —
      // srt's SandboxManager is itself process-wide, so this file must not build
      // a second backend beside the one the rest of the live suite uses.
      const launcher = createCommandLauncher({
        state: { kind: "available", backend: "srt", network: "open" },
        backend: sandboxBackendFor(CONFIG),
        policyFor: async (r) => ({ writeRoots: [r], denyWrite: [], denyRead: [], network: {} }),
      });
      const tool = createBashTool({ launcher });

      const result = await tool.run(
        { command: "echo AGENT=$AGENT" },
        { root, resolvedPaths: [], maxBytes: 40_000, maxFileBytes: 2_000_000 },
      );

      expect(result.isError).not.toBe(true);
      expect(result.content).toContain("AGENT=1");
    }, 60_000);
  });
});
