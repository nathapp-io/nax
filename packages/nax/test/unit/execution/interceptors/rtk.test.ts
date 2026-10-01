import { describe, expect, test } from "bun:test";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { waitForCondition, withTempDir } from "@test/helpers";
import type { CommandInterceptor, ShellInterceptRequest, ShellInterceptResult } from "@/execution/command-interceptor";
import type { InterceptorState, RtkDeps, RtkRewriteResult } from "@/execution/interceptors/rtk";
import { createRtkInterceptor, RTK_REWRITE_TIMEOUT_MS } from "@/execution/interceptors/rtk";
import type { LogEntry } from "@/logger";
import { addSink, initLogger, resetLogger } from "@/logger";
import { isProcessAlive } from "@/utils/process-alive";

const req = (verb: string) => ({
  kind: "argv" as const,
  argv: ["git", verb, "--oneline"],
  cwd: "/repo",
  site: "git" as const,
});
const present = { which: () => "/usr/bin/rtk", version: () => "0.45.0", record: () => {} };
const make = (o: Partial<Parameters<typeof createRtkInterceptor>[0]> = {}) =>
  createRtkInterceptor({ enabled: true, verbs: ["log"], _deps: present, ...o });

/** One construction with the DEFAULT record, returning the log lines it wrote. */
function logLinesOf(opts: Partial<Parameters<typeof createRtkInterceptor>[0]>): LogEntry[] {
  resetLogger();
  initLogger({ level: "silent" });
  const entries: LogEntry[] = [];
  addSink((entry) => entries.push(entry));
  try {
    createRtkInterceptor({
      enabled: true,
      verbs: ["log"],
      ...opts,
      _deps: { which: () => "/usr/bin/rtk", version: () => "0.45.0" },
    });
  } finally {
    resetLogger();
  }
  return entries;
}

describe("rtk interceptor", () => {
  test("rewrites a verb in the configured list", async () => {
    expect(await make().intercept(req("log"))).toEqual({
      kind: "rewritten",
      argv: ["rtk", "git", "log", "--oneline"],
      provider: "rtk",
    });
  });

  test("leaves a verb outside the list unchanged", async () => {
    expect((await make().intercept(req("diff"))).kind).toBe("unchanged");
  });

  test("an empty verb list intercepts nothing", async () => {
    expect((await make({ verbs: [] }).intercept(req("log"))).kind).toBe("unchanged");
  });

  test("never probes the binary when disabled", async () => {
    let probed = false;
    const i = make({
      enabled: false,
      _deps: {
        ...present,
        which: () => {
          probed = true;
          return "/usr/bin/rtk";
        },
      },
    });
    expect((await i.intercept(req("log"))).kind).toBe("unchanged");
    expect(probed).toBe(false);
  });

  test("records the real version at construction when enabled", () => {
    const states: InterceptorState[] = [];
    make({ _deps: { ...present, record: (s) => states.push(s) } });
    expect(states).toEqual([{ enabled: true, version: "0.45.0", verbs: ["log"], bash: false }]);
  });

  test("still records, with a null version, when disabled", () => {
    const states: InterceptorState[] = [];
    make({ enabled: false, _deps: { ...present, record: (s) => states.push(s) } });
    expect(states).toEqual([{ enabled: false, version: null, verbs: ["log"], bash: false }]);
  });

  test("US-002 AC20: records bash: true when the Bash site is opted in", () => {
    const states: InterceptorState[] = [];
    make({ bash: true, _deps: { ...present, record: (s) => states.push(s) } });
    expect(states).toEqual([{ enabled: true, version: "0.45.0", verbs: ["log"], bash: true }]);
  });

  test("US-002 AC21: records bash: false when the option is absent", () => {
    // `bash` is optional on the options object, so an argv-only caller from
    // before US-002 must still produce the full four-field record.
    const states: InterceptorState[] = [];
    make({ _deps: { ...present, record: (s) => states.push(s) } });
    expect(states).toEqual([{ enabled: true, version: "0.45.0", verbs: ["log"], bash: false }]);
  });

  test("a missing binary declines forever and is probed exactly once", async () => {
    let probes = 0;
    const i = make({
      _deps: {
        ...present,
        which: () => {
          probes += 1;
          return null;
        },
      },
    });
    expect((await i.intercept(req("log"))).kind).toBe("declined");
    expect((await i.intercept(req("log"))).kind).toBe("declined");
    expect(probes).toBe(1);
  });

  test("construction never throws, and a throwing probe degrades to declined", async () => {
    // A throw here would take down run setup (Task 6 installs this in setupRun).
    let i: ReturnType<typeof make> | undefined;
    expect(() => {
      i = make({
        _deps: {
          ...present,
          which: () => {
            throw new Error("boom");
          },
        },
      });
    }).not.toThrow();
    expect((await i?.intercept(req("log")))?.kind).toBe("declined");
  });

  test("construction never throws when the version probe is the thing that fails", async () => {
    let i: ReturnType<typeof make> | undefined;
    expect(() => {
      i = make({
        _deps: {
          ...present,
          version: () => {
            throw new Error("boom");
          },
        },
      });
    }).not.toThrow();
    expect((await i?.intercept(req("log")))?.kind).toBe("declined");
  });

  test("partial deps fall back to the real which probe without throwing", async () => {
    // rtk may or may not be installed; either way construction probes without
    // throwing and records once, and interception settles on a valid outcome.
    const states: InterceptorState[] = [];
    const i = createRtkInterceptor({
      enabled: true,
      verbs: ["log"],
      _deps: { record: (s) => states.push(s) },
    });
    expect(states).toHaveLength(1);
    expect(states[0].enabled).toBe(true);
    const result = await i.intercept(req("log"));
    expect(["rewritten", "declined"]).toContain(result.kind);
  });

  test("partial deps fall back to the real version probe without throwing", async () => {
    // `rtk --version` resolves on a machine with rtk installed (rewritten) and
    // throws ENOENT where rtk is absent (degraded to declined by construction).
    // Either outcome is valid; what matters is that construction did not throw.
    const states: InterceptorState[] = [];
    const i = createRtkInterceptor({
      enabled: true,
      verbs: ["log"],
      _deps: {
        which: () => "/usr/bin/rtk",
        record: (s) => states.push(s),
      },
    });
    expect(states).toHaveLength(1);
    expect(states[0].enabled).toBe(true);
    const result = await i.intercept(req("log"));
    expect(["rewritten", "declined"]).toContain(result.kind);
  });

  test("the default record writes one structured info line via the logger", () => {
    const entries = logLinesOf({});
    expect(entries).toHaveLength(1);
    expect(entries[0].level).toBe("info");
    expect(entries[0].stage).toBe("execution");
    expect(entries[0].data).toEqual({ enabled: true, version: "0.45.0", verbs: ["log"], bash: false });
  });

  test("US-002: the default record logs bash: true when the Bash site is opted in", () => {
    const entries = logLinesOf({ bash: true });
    expect(entries).toHaveLength(1);
    expect(entries[0].data).toEqual({ enabled: true, version: "0.45.0", verbs: ["log"], bash: true });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// postProcess — strip rtk's appended hints from a tool result
// ─────────────────────────────────────────────────────────────────────────────

const postProcessReq = { kind: "argv" as const, argv: ["git", "log"], cwd: "/repo", site: "git" as const };

/** Narrows `postProcess?` once, so no test needs a non-null assertion. */
function postProcess() {
  const { postProcess: fn } = createRtkInterceptor({
    enabled: true,
    verbs: ["log"],
    _deps: present,
  });
  if (fn === undefined) throw new Error("rtk interceptor must define postProcess");
  return fn;
}

describe("rtk postProcess", () => {
  test("strips a full-diff hint and the newline before it", () => {
    expect(postProcess()("diff body\n[full diff: rtk git diff --no-compact]", postProcessReq).output).toBe("diff body");
  });

  test("strips a hidden-lines hint", () => {
    const { output } = postProcess()("body\n[+12 hidden: rtk recall 3f9c2a81d4e7]", postProcessReq);
    expect(output).toBe("body");
    expect(output).not.toContain("rtk recall");
  });

  test("strips a full-output hint", () => {
    // US-005 item 1 names `[full output: rtk recall <hash>]` as the third hint
    // shape rtk appends — the acceptance is "no rtk hint string survives into
    // a tool result".
    expect(postProcess()("body\n[full output: rtk recall 3f9c2a81d4e7]", postProcessReq).output).toBe("body");
  });

  test("leaves output with no hints untouched", () => {
    expect(postProcess()("plain body", postProcessReq).output).toBe("plain body");
  });

  test("does not eat trailing whitespace when there is no hint to strip", () => {
    // Stripping is hint-shaped, not a general trim: trimEnd happens later at
    // the call site, and postProcess must not pre-empt it.
    expect(postProcess()("plain body\n\n", postProcessReq).output).toBe("plain body\n\n");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-002 interceptShell — one `rtk rewrite` answer becomes the Bash site's
// answer. The decision table IS the contract, so every row is pinned here.
// ─────────────────────────────────────────────────────────────────────────────

const shellReq: ShellInterceptRequest = { kind: "shell", command: "bun test", cwd: "/repo", site: "bash" };

type RewriteAnswer = RtkRewriteResult | ((command: string, cwd: string) => Promise<RtkRewriteResult>);

/** Narrows `interceptShell?` once, so no test needs a non-null assertion. */
function shellOf(interceptor: CommandInterceptor): (req: ShellInterceptRequest) => Promise<ShellInterceptResult> {
  const { interceptShell } = interceptor;
  if (interceptShell === undefined) throw new Error("rtk interceptor must implement interceptShell");
  return interceptShell.bind(interceptor);
}

/**
 * An interceptor opted into the Bash site whose `rewrite` records every call and
 * answers from the scripted result; `calls` is how "never called" is asserted.
 */
function shellProvider(
  answer: RewriteAnswer,
  options: { enabled?: boolean; bash?: boolean; which?: (bin: string) => string | null } = {},
) {
  const calls: Array<{ command: string; cwd: string }> = [];
  const rewrite: RtkDeps["rewrite"] = async (command, cwd) => {
    calls.push({ command, cwd });
    return typeof answer === "function" ? answer(command, cwd) : answer;
  };
  const interceptor = createRtkInterceptor({
    enabled: options.enabled ?? true,
    verbs: [],
    bash: options.bash ?? true,
    _deps: {
      which: options.which ?? (() => "/usr/bin/rtk"),
      version: () => "0.45.0",
      record: () => {},
      rewrite,
    },
  });
  return { calls, shell: shellOf(interceptor) };
}

describe("rtk interceptShell (US-002)", () => {
  test("US-002 AC7: exit 3 with a newline and a changed command is a rewrite", async () => {
    const { calls, shell } = shellProvider({ exitCode: 3, stdout: "rtk bun test\n", timedOut: false });
    expect(await shell(shellReq)).toEqual({ kind: "rewritten", command: "rtk bun test", provider: "rtk" });
    expect(calls).toEqual([{ command: "bun test", cwd: "/repo" }]);
  });

  test("US-002 AC7 (boundary): the rewritten command is the TRIMMED stdout", async () => {
    const { shell } = shellProvider({ exitCode: 3, stdout: "  rtk bun test \n", timedOut: false });
    expect(await shell(shellReq)).toEqual({ kind: "rewritten", command: "rtk bun test", provider: "rtk" });
  });

  test("US-002 AC8: exit 0 is accepted as a rewrite", async () => {
    const { shell } = shellProvider({ exitCode: 0, stdout: "rtk bun test", timedOut: false });
    expect(await shell(shellReq)).toEqual({ kind: "rewritten", command: "rtk bun test", provider: "rtk" });
  });

  test("US-002 AC9: exit 1 leaves the command alone", async () => {
    const { shell } = shellProvider({ exitCode: 1, stdout: "", timedOut: false });
    expect(await shell(shellReq)).toEqual({ kind: "unchanged" });
  });

  test("US-002 AC10: exit 3 echoing the original command is unchanged", async () => {
    const { shell } = shellProvider({ exitCode: 3, stdout: "bun test", timedOut: false });
    expect(await shell(shellReq)).toEqual({ kind: "unchanged" });
  });

  test("US-002 AC10 (boundary): exit 0 echoing the original command is unchanged", async () => {
    const { shell } = shellProvider({ exitCode: 0, stdout: "bun test", timedOut: false });
    expect(await shell(shellReq)).toEqual({ kind: "unchanged" });
  });

  test("US-002 AC11: exit 3 with no stdout is unchanged", async () => {
    const { shell } = shellProvider({ exitCode: 3, stdout: "", timedOut: false });
    expect(await shell(shellReq)).toEqual({ kind: "unchanged" });
  });

  test("US-002 AC11 (boundary): whitespace-only stdout is unchanged", async () => {
    // There is nothing to run: the rewrite branch needs a trimmed, non-empty
    // stdout that differs from the original.
    const { shell } = shellProvider({ exitCode: 3, stdout: "\n  \n", timedOut: false });
    expect(await shell(shellReq)).toEqual({ kind: "unchanged" });
  });

  test("US-002 AC12: exit 2 (a provider deny rule) declines", async () => {
    const { shell } = shellProvider({ exitCode: 2, stdout: "", timedOut: false });
    expect(await shell(shellReq)).toEqual({ kind: "declined", reason: "rtk rewrite exited 2" });
  });

  test("US-002 AC13: exit 127 declines with its own code in the reason", async () => {
    const { shell } = shellProvider({ exitCode: 127, stdout: "", timedOut: false });
    expect(await shell(shellReq)).toEqual({ kind: "declined", reason: "rtk rewrite exited 127" });
  });

  test("US-002 AC14: a timed-out rewrite declines", async () => {
    const { shell } = shellProvider({ exitCode: -1, stdout: "", timedOut: true });
    expect(await shell(shellReq)).toEqual({ kind: "declined", reason: "rtk rewrite timed out" });
  });

  test("US-002 AC15: a rejecting rewrite declines with the error message", async () => {
    const { shell } = shellProvider(async () => {
      throw new Error("spawn ENOENT");
    });
    expect(await shell(shellReq)).toEqual({ kind: "declined", reason: "rtk rewrite failed: spawn ENOENT" });
  });

  test("US-002 AC16: bash: false leaves the command alone and never rewrites", async () => {
    const { calls, shell } = shellProvider({ exitCode: 3, stdout: "rtk bun test\n", timedOut: false }, { bash: false });
    expect(await shell(shellReq)).toEqual({ kind: "unchanged" });
    expect(calls).toEqual([]);
  });

  test("US-002 AC17: enabled: false leaves the command alone and never rewrites", async () => {
    const { calls, shell } = shellProvider(
      { exitCode: 3, stdout: "rtk bun test\n", timedOut: false },
      { enabled: false },
    );
    expect(await shell(shellReq)).toEqual({ kind: "unchanged" });
    expect(calls).toEqual([]);
  });

  test("US-002 AC18: a missing binary declines for the Bash site too, without rewriting", async () => {
    const { calls, shell } = shellProvider(
      { exitCode: 3, stdout: "rtk bun test\n", timedOut: false },
      { which: () => null },
    );
    expect(await shell(shellReq)).toEqual({ kind: "declined", reason: "rtk binary not found on PATH" });
    expect(calls).toEqual([]);
  });

  test("US-002 AC19: a throwing probe declines with the probe message", async () => {
    const { calls, shell } = shellProvider(
      { exitCode: 3, stdout: "rtk bun test\n", timedOut: false },
      {
        which: () => {
          throw new Error("boom");
        },
      },
    );
    expect(await shell(shellReq)).toEqual({ kind: "declined", reason: "rtk probe failed: boom" });
    expect(calls).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-002 defaultRewrite — the DEFAULT implementation of `RtkDeps.rewrite`,
// exercised against a fake `rtk` binary. Only the binary is fake: the exit code,
// the timeout and the kill are observed for real, which is exactly why the raw
// result type is exported.
//
// It is driven inside a CHILD bun, whose PATH already starts with the fake. Bun
// resolves a spawn's executable against the PATH it snapshotted when the process
// STARTED, so mutating `process.env.PATH` in this test process would send the
// spawn to whatever `rtk` the machine happens to have installed — a real binary
// on a developer machine, none in CI. Neither is a test of the fake.
//
// The child imports the same module the Bash seam imports, so what it drives is
// the exported `defaultRewrite` itself — only the process boundary is new.
// ─────────────────────────────────────────────────────────────────────────────

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..");

/** What the child reports: `defaultRewrite`'s answer (or its rejection) and how long it took. */
interface FakeRun {
  /** Parsed child report — the raw `RtkRewriteResult`, or `{ rejected, message }`. */
  outcome: unknown;
  /** `defaultRewrite`'s own duration, measured inside the child. */
  elapsedMs: number;
  /** Pid the fake recorded, or 0 when it never ran. */
  pid: number;
}

/** Child source: call `defaultRewrite`, then report what it answered or how it failed. */
function childCode(command: string, cwd: string): string {
  return [
    'const { defaultRewrite } = await import("@/execution/interceptors/rtk");',
    "const started = Date.now();",
    "try {",
    `  console.log(JSON.stringify(await defaultRewrite(${JSON.stringify(command)}, ${JSON.stringify(cwd)})));`,
    "} catch (err) {",
    "  console.log(JSON.stringify({ rejected: true, message: String(err && err.message ? err.message : err) }));",
    "}",
    "console.log(JSON.stringify(Date.now() - started));",
  ].join("\n");
}

/**
 * Runs the child with `pathValue` as its whole PATH. Tests do not assert on a
 * failed child directly: a green child that reports a rejection is the point.
 */
async function runChild(command: string, cwd: string, pathValue: string): Promise<FakeRun> {
  const child = Bun.spawn([process.execPath, "-e", childCode(command, cwd)], {
    cwd: REPO_ROOT,
    env: { ...process.env, PATH: pathValue },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`[rtk test] child bun exited ${exitCode}: ${stderr.trim() || stdout.trim()}`);
  }
  const [outcomeLine, elapsedLine] = stdout.trim().split("\n");
  return {
    outcome: JSON.parse(outcomeLine ?? "null"),
    elapsedMs: Number(JSON.parse(elapsedLine ?? "0")),
    pid: 0,
  };
}

/** `runChild` against an executable `rtk` first on PATH; `%PID%` becomes a pid-file path. */
async function runWithFakeRtk(body: string): Promise<FakeRun> {
  return withTempDir(async (dir) => {
    const pidFile = join(dir, "pid");
    const binDir = join(dir, "bin");
    await mkdir(binDir, { recursive: true });
    await writeFile(join(binDir, "rtk"), `#!/bin/sh\n${body.replaceAll("%PID%", pidFile)}\n`);
    await chmod(join(binDir, "rtk"), 0o755);

    const run = await runChild("bun test", dir, `${binDir}:${process.env.PATH ?? ""}`);
    if (!(await Bun.file(pidFile).exists())) return run;
    return { ...run, pid: Number((await Bun.file(pidFile).text()).trim()) };
  });
}

describe("rtk defaultRewrite (US-002)", () => {
  test("US-002 AC22: the exported bound is the documented 2000 ms", () => {
    expect(RTK_REWRITE_TIMEOUT_MS).toBe(2000);
  });

  test.concurrent("US-002 AC22: a sleeping rtk is timed out within the bound, after really running", async () => {
    const run = await runWithFakeRtk('echo $$ > "%PID%"\nexec sleep 8');
    expect(run.outcome).toEqual({ exitCode: -1, stdout: "", timedOut: true });
    expect(run.elapsedMs).toBeLessThanOrEqual(RTK_REWRITE_TIMEOUT_MS + 1000);
    // The recorded pid is what proves the fake really ran: an answer that never
    // spawned a child would satisfy the shape above and fail here.
    expect(run.pid).toBeGreaterThan(0);
  }, 20_000);

  test.concurrent("US-002 AC23: the timed-out child is no longer a running process", async () => {
    const run = await runWithFakeRtk('echo $$ > "%PID%"\nexec sleep 8');
    expect(run.outcome).toEqual({ exitCode: -1, stdout: "", timedOut: true });
    expect(run.pid).toBeGreaterThan(0);
    // The signal may land a moment after the answer resolves, so poll rather
    // than sleep; the assertion below, not the helper, is the verdict.
    await waitForCondition(() => !isProcessAlive(run.pid), 3_000, 25).catch(() => {});
    expect(isProcessAlive(run.pid)).toBe(false);
  }, 20_000);

  test("US-002 AC24: exit 3 and stdout are reported verbatim", async () => {
    // The guard is deliberate: it matches ONLY the story's argv contract —
    // `rtk rewrite <command>`, the command passed as a single argument — so a
    // spawn that splits or reorders it exits 9 and fails here rather than
    // passing quietly.
    const body = [
      'if [ "$#" -eq 2 ] && [ "$1" = "rewrite" ] && [ "$2" = "bun test" ]; then',
      '  printf "rtk bun test\\n"',
      "  exit 3",
      "fi",
      "exit 9",
    ].join("\n");
    const run = await runWithFakeRtk(body);
    expect(run.outcome).toEqual({ exitCode: 3, stdout: "rtk bun test\n", timedOut: false });
  }, 20_000);

  test("US-002 AC15 (boundary): a spawn failure rejects instead of answering", async () => {
    // interceptShell maps a rejection to `rtk rewrite failed: <message>`, so a
    // swallowed spawn error here would leave an unusable provider looking fine.
    const run = await runChild("bun test", REPO_ROOT, "/nonexistent-path-for-nax-test");
    expect(run.outcome).toMatchObject({ rejected: true });
  }, 20_000);
});
