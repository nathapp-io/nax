/**
 * US-003 — the Bash tool runs the VALIDATED rtk rewrite, after the permission
 * decision.
 *
 * The permission policy and the command-safety guard both judge the model's
 * ORIGINAL command string: `callTool` lexes and gates that string, decides, and
 * only then calls `Bash.run`. So the interception cannot live above the tool —
 * it has to happen inside it, after the verdict, and everything below is
 * asserted at one of two seams:
 *
 *   - `_bashToolDeps.interceptor` — the run-scoped interceptor `setupRun`
 *     installs on the Bash tool as well as the Git tool (the install itself is
 *     pinned in test/unit/execution/lifecycle/run-setup-command-interceptor.test.ts);
 *   - `_bashToolDeps.runArgv` / the launcher — where the rewritten argv, and
 *     therefore "did the rewrite actually run?", become observable.
 *
 * AC1-AC8 drive the real `createCodingToolRuntime(...).callTool`, so the
 * ORDERING — verdict first, interception second — is part of the test rather
 * than a stated assumption about it. AC9-AC15 drive `createBashTool` directly,
 * where the launcher request, the framed output and the exit status are the
 * observable result.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir, withDepsRestore } from "@test/helpers";
import type {
  CommandInterceptor,
  InterceptRequest,
  InterceptResult,
  ShellInterceptRequest,
  ShellInterceptResult,
} from "@/execution/command-interceptor";
import type { RtkRewriteResult } from "@/execution/interceptors/rtk";
import { createRtkInterceptor } from "@/execution/interceptors/rtk";
import type { CommandLauncher, LaunchRequest } from "@/sandbox";
import { DISABLED_SANDBOX_STATE } from "@/sandbox";
import { _bashToolDeps, compileToolPolicy, createBashTool, createCodingToolRuntime } from "@/tools";
import type { ToolCallRecord } from "@/tools/tool-audit";

/** The model's command, and what the provider answers for it. */
const ORIGINAL = "bun test a.test.ts";
const REWRITTEN = "rtk bun test a.test.ts";
/** rtk appends this to rewritten output; the Bash site must strip it too. */
const HINTED_STDOUT = "out\n[full output: rtk recall 12]";

const realRunArgv = _bashToolDeps.runArgv;

let root: string;
let calls: Parameters<typeof realRunArgv>[0][];

/** Replace the spawn seam, recording every call. */
function stubRunArgv(result: Partial<Awaited<ReturnType<typeof realRunArgv>>> = {}): void {
  _bashToolDeps.runArgv = async (options) => {
    calls.push(options);
    return { exitCode: 0, stdout: "out", stderr: "", timedOut: false, ...result };
  };
}

/** The real provider interceptor with its one subprocess stubbed, so nothing spawns. */
function rtkWithRewrite(rewrite: (command: string, cwd: string) => Promise<RtkRewriteResult>): CommandInterceptor {
  return createRtkInterceptor({
    enabled: true,
    verbs: [],
    bash: true,
    _deps: { which: () => "/usr/bin/rtk", version: () => "0.45.0", record: () => {}, rewrite },
  });
}

/** The provider answering `candidate` for whatever it is asked. */
function rtkRewritingTo(candidate: string): CommandInterceptor {
  return rtkWithRewrite(async () => ({ exitCode: 0, stdout: candidate, timedOut: false }));
}

/**
 * The real provider, wrapped so every `interceptShell` request is captured —
 * keeps the real validator in the path while making "was the interceptor
 * consulted at all?" observable.
 */
function recordingAround(inner: CommandInterceptor): {
  interceptor: CommandInterceptor;
  seen: ShellInterceptRequest[];
} {
  const seen: ShellInterceptRequest[] = [];
  const innerShell = inner.interceptShell;
  return {
    seen,
    interceptor: {
      ...inner,
      interceptShell: async (req: ShellInterceptRequest): Promise<ShellInterceptResult> => {
        seen.push(req);
        return innerShell === undefined ? { kind: "unchanged" } : innerShell(req);
      },
    },
  };
}

interface RecordingShellStub {
  readonly interceptor: CommandInterceptor;
  /** Every `interceptShell` request the tool sent. */
  readonly seen: ShellInterceptRequest[];
  /** Every `postProcess` request the tool sent. */
  readonly postRequests: (InterceptRequest | ShellInterceptRequest)[];
  readonly postCalls: () => number;
}

/**
 * A recording stand-in for the provider: the shell answer is scripted, every
 * request is captured, and `post` decides what `postProcess` returns — a throw
 * from it is the AC13 case.
 */
function recordingStub(answer: ShellInterceptResult, post?: (output: string) => string): RecordingShellStub {
  const seen: ShellInterceptRequest[] = [];
  const postRequests: (InterceptRequest | ShellInterceptRequest)[] = [];
  let postCalls = 0;
  return {
    seen,
    postRequests,
    postCalls: () => postCalls,
    interceptor: {
      provider: "rtk",
      intercept: async (): Promise<InterceptResult> => ({ kind: "unchanged" }),
      interceptShell: async (req: ShellInterceptRequest): Promise<ShellInterceptResult> => {
        seen.push(req);
        return answer;
      },
      postProcess: (output: string, req: InterceptRequest | ShellInterceptRequest) => {
        postCalls += 1;
        postRequests.push(req);
        return { output: post === undefined ? output : post(output) };
      },
    },
  };
}

/** The real runtime: a gated policy over `root`, with the Bash tool registered. */
function runtimeFor(patterns: readonly string[] = ["bun test *"]) {
  const records: ToolCallRecord[] = [];
  const runtime = createCodingToolRuntime({
    policy: compileToolPolicy([{ tool: "Bash", patterns }], root),
    sink: { record: (entry) => void records.push(entry), flush: async () => {} },
    extraTools: [createBashTool()],
  });
  return { runtime, records };
}

/** A launcher that records the request it was handed instead of spawning. */
function capturingLauncher(): { launcher: CommandLauncher; requests: LaunchRequest[] } {
  const requests: LaunchRequest[] = [];
  return {
    requests,
    launcher: {
      state: DISABLED_SANDBOX_STATE,
      async run(req) {
        requests.push(req);
        return {
          exitCode: 0,
          stdout: "out",
          stderr: "",
          timedOut: false,
          executed: req.spec.kind === "shell" ? [req.spec.shell, "-c", req.spec.command] : [...req.spec.argv],
          sandbox: { backend: "none", wrapped: false },
        };
      },
    },
  };
}

const ctx = () => ({ root, resolvedPaths: [], maxBytes: 40_000, maxFileBytes: 2_000_000 });

describe("US-003 Bash interception", () => {
  // Module-level state is per-process: an interceptor left installed here would
  // reach every later test file.
  withDepsRestore(_bashToolDeps, ["runArgv", "interceptor"]);

  beforeEach(() => {
    // `compileToolPolicy` realpaths its root (`realOrRaw`), so the root the
    // runtime hands the tool is the resolved one: macOS resolves /tmp ->
    // /private/tmp. Compare like with like — on Linux realpath is a no-op.
    // Same seam as test/unit/tools/ask-request-payload.test.ts.
    root = realpathSync(makeTempDir("bash-intercept-"));
    calls = [];
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
  });

  afterEach(() => cleanupTempDir(root));

  describe("the granted call, through createCodingToolRuntime (AC1-AC8)", () => {
    test("US-003 AC1: the validated rewrite is the command that runs", async () => {
      _bashToolDeps.interceptor = rtkRewritingTo(REWRITTEN);
      stubRunArgv();

      await runtimeFor().runtime.callTool("Bash", { command: ORIGINAL });

      expect(calls[0]?.argv).toEqual(["/bin/sh", "-c", REWRITTEN]);
    });

    test("US-003 AC2: interceptShell receives the model's ORIGINAL command", async () => {
      const stub = recordingStub({ kind: "rewritten", command: REWRITTEN, provider: "rtk" });
      _bashToolDeps.interceptor = stub.interceptor;
      stubRunArgv();

      await runtimeFor().runtime.callTool("Bash", { command: ORIGINAL });

      expect(stub.seen).toEqual([{ kind: "shell", command: ORIGINAL, cwd: root, site: "bash" }]);
    });

    test("US-003 AC3: a command the gated policy does not grant is denied", async () => {
      stubRunArgv();

      const outcome = await runtimeFor().runtime.callTool("Bash", { command: "rm -rf src" });

      expect(outcome.kind).toBe("denied");
    });

    test("US-003 AC4: a denied call never reaches interceptShell", async () => {
      const stub = recordingStub({ kind: "rewritten", command: REWRITTEN, provider: "rtk" });
      _bashToolDeps.interceptor = stub.interceptor;
      stubRunArgv();

      const outcome = await runtimeFor().runtime.callTool("Bash", { command: "rm -rf src" });

      // Premise (AC3): the call really is refused. Without it, "interceptShell
      // was not called" would hold for a call that ran without interception.
      expect(outcome.kind).toBe("denied");
      expect(stub.seen).toHaveLength(0);
    });

    test("US-003 AC5: the granted call's audit records the rewritten argv as executed", async () => {
      _bashToolDeps.interceptor = rtkRewritingTo(REWRITTEN);
      stubRunArgv();

      const { runtime, records } = runtimeFor();
      await runtime.callTool("Bash", { command: ORIGINAL });

      // The ledger's `executed` is the tool result's `audit.executed`, forwarded
      // verbatim by `runTool` — so this is the audit, seen through callTool.
      expect(records[0]?.executed).toEqual(["/bin/sh", "-c", REWRITTEN]);
    });

    test("US-003 AC6: a candidate the validator declines runs the original command", async () => {
      // rtk's own answer for `cat src/a.ts` is `rtk read src/a.ts` — a rewrite
      // that changes the command word, which validateShellRewrite refuses.
      const stub = recordingAround(rtkRewritingTo("rtk read src/a.ts"));
      _bashToolDeps.interceptor = stub.interceptor;
      stubRunArgv();

      await runtimeFor(["cat *"]).runtime.callTool("Bash", { command: "cat src/a.ts" });

      // Premise: the provider really was consulted with this command, so the
      // original running means the candidate was DECLINED, not ignored.
      expect(stub.seen).toEqual([{ kind: "shell", command: "cat src/a.ts", cwd: root, site: "bash" }]);
      expect(calls[0]?.argv).toEqual(["/bin/sh", "-c", "cat src/a.ts"]);
    });

    test("US-003 AC7: with no interceptor installed the original command runs", async () => {
      _bashToolDeps.interceptor = undefined;
      stubRunArgv();

      await runtimeFor().runtime.callTool("Bash", { command: ORIGINAL });

      expect(calls[0]?.argv).toEqual(["/bin/sh", "-c", ORIGINAL]);
    });

    test("US-003 AC8: with no interceptor installed the audit records the original argv", async () => {
      _bashToolDeps.interceptor = undefined;
      stubRunArgv();

      const { runtime, records } = runtimeFor();
      await runtime.callTool("Bash", { command: ORIGINAL });

      expect(records[0]?.executed).toEqual(["/bin/sh", "-c", ORIGINAL]);
    });
  });

  describe("launcher, post-processing and framing (AC9-AC13)", () => {
    test("US-003 AC9: the launcher is handed the rewritten command as a shell spec", async () => {
      _bashToolDeps.interceptor = rtkRewritingTo(REWRITTEN);
      const { launcher, requests } = capturingLauncher();

      await createBashTool({ launcher }).run({ command: ORIGINAL }, ctx());

      expect(requests[0]?.spec).toEqual({ kind: "shell", shell: "/bin/sh", command: REWRITTEN });
    });

    test("US-003 AC10: a rewritten call's output has the rtk hint line stripped", async () => {
      _bashToolDeps.interceptor = rtkRewritingTo(REWRITTEN);
      stubRunArgv({ stdout: HINTED_STDOUT });

      const result = await createBashTool().run({ command: ORIGINAL }, ctx());

      // The framing is `exit <code>\n<stdout>\n<stderr>` over the POST-PROCESSED
      // stdout, and rtk's hint regex takes the newline before the hint with it.
      expect(result.content).toBe("exit 0\nout\n");
    });

    test("US-003 AC11: an unrewritten call keeps the hint line", async () => {
      // The stub WOULD strip the hint if it were consulted, and answers
      // `unchanged` — so postProcess is gated on the rewrite, not on the
      // interceptor being installed.
      const stub = recordingStub({ kind: "unchanged" }, (output) =>
        output.replace("\n[full output: rtk recall 12]", ""),
      );
      _bashToolDeps.interceptor = stub.interceptor;
      stubRunArgv({ stdout: HINTED_STDOUT });

      const result = await createBashTool().run({ command: ORIGINAL }, ctx());

      // Premise: the interceptor really was consulted for this call.
      expect(stub.seen).toHaveLength(1);
      expect(result.content).toBe("exit 0\nout\n[full output: rtk recall 12]\n");
    });

    test("US-003 AC12: postProcess receives the model's original command, the root and the bash site", async () => {
      const stub = recordingStub({ kind: "rewritten", command: REWRITTEN, provider: "rtk" });
      _bashToolDeps.interceptor = stub.interceptor;
      stubRunArgv({ stdout: "out" });

      await createBashTool().run({ command: ORIGINAL }, ctx());

      expect(stub.postRequests).toEqual([{ kind: "shell", command: ORIGINAL, cwd: root, site: "bash" }]);
    });

    test("US-003 AC13: a throwing postProcess degrades to the raw stdout", async () => {
      const stub = recordingStub({ kind: "rewritten", command: REWRITTEN, provider: "rtk" }, () => {
        throw new Error("postProcess exploded");
      });
      _bashToolDeps.interceptor = stub.interceptor;
      stubRunArgv({ stdout: "raw stdout" });

      const result = await createBashTool().run({ command: ORIGINAL }, ctx());

      // Premise: the throwing hook really was consulted. Without it the raw
      // stdout below is what a tool with no post-processing at all returns.
      expect(stub.postCalls()).toBe(1);
      expect(result.content).toBe("exit 0\nraw stdout\n");
    });
  });

  describe("a rewritten command that fails (AC14-AC15)", () => {
    test("US-003 AC14: a rewritten command exiting 1 is an error carrying the exit code", async () => {
      _bashToolDeps.interceptor = rtkRewritingTo(REWRITTEN);
      // Only the REWRITTEN argv fails, so "a rewritten command exits 1" is a
      // property of the call rather than an incidental result the original
      // command could also have produced.
      _bashToolDeps.runArgv = async (options) => {
        calls.push(options);
        const rewritten = options.argv[2] === REWRITTEN;
        return {
          exitCode: rewritten ? 1 : 0,
          stdout: "",
          stderr: rewritten ? "test failed" : "",
          timedOut: false,
        };
      };

      const result = await createBashTool().run({ command: ORIGINAL }, ctx());

      expect(result.isError).toBe(true);
      expect(result.audit?.exitCode).toBe(1);
    });

    test("US-003 AC15: the failed rewrite is never re-run as the original", async () => {
      _bashToolDeps.interceptor = rtkRewritingTo(REWRITTEN);
      stubRunArgv({ exitCode: 1, stdout: "", stderr: "" });

      await createBashTool().run({ command: ORIGINAL }, ctx());

      expect(calls).toHaveLength(1);
      expect(calls[0]?.argv).toEqual(["/bin/sh", "-c", REWRITTEN]);
    });
  });
});
