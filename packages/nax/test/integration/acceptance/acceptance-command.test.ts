/**
 * US-001: an acceptance command is ONE shell string, executed through
 * `/bin/sh -c` by every acceptance runner.
 *
 * These tests deliberately cross the module boundary: the string the builder
 * produces has to survive a real shell (`_acceptanceSetupDeps.runTest`), and
 * the post-run acceptance stage has to spawn it as `["/bin/sh", "-c", cmd]`
 * instead of splitting it back into argv words.
 *
 * The first describe block reaches the real `/bin/sh` — that IS the behaviour
 * under test (a leading `VAR=value` assignment only survives if the command
 * reaches the shell unquoted), and both commands it runs (`true`, `printenv`)
 * are POSIX built-ins/coreutils inside a temp workdir, so nothing leaves the
 * machine.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import path from "node:path";
import { cleanupTempDir, makeSpawn, makeTempDir, makeTestContext, makeTestPRD, makeTestStory } from "@test/helpers";
import { addSink, initLogger, type LogEntry, resetLogger } from "@/logger";
import { acceptanceStage } from "@/pipeline/stages/acceptance";
import { _acceptanceSetupDeps } from "@/pipeline/stages/acceptance-setup";
import { _executorDeps } from "@/verification";

let workdir: string;
let testPath: string;

beforeEach(async () => {
  initLogger({ level: "silent" });
  workdir = makeTempDir("nax-acceptance-command-");
  testPath = path.join(workdir, ".nax-acceptance.test.ts");
  await Bun.write(
    testPath,
    `import { describe, expect, test } from "bun:test";

describe("acceptance", () => {
  test("AC-1: works", () => {
    expect(true).toBe(true);
  });
});
`,
  );
});

afterEach(() => {
  cleanupTempDir(workdir);
  resetLogger();
});

describe("US-001: the acceptance command reaches the real shell", () => {
  test("AC9: a leading env assignment is not quoted, so runTest resolves with exitCode 0", async () => {
    const result = await _acceptanceSetupDeps.runTest(testPath, workdir, "NAX_ACC_PROBE=1 true");

    expect(result.exitCode).toBe(0);
  });

  test("AC9 boundary: && reaches the shell as an operator, not as a quoted word", async () => {
    const result = await _acceptanceSetupDeps.runTest(testPath, workdir, "NAX_ACC_PROBE=1 true && echo chained");

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("chained");
  });

  test("AC9 boundary: the shell's own exit code is reported unchanged", async () => {
    const result = await _acceptanceSetupDeps.runTest(testPath, workdir, "NAX_ACC_PROBE=1 exit 7");

    expect(result.exitCode).toBe(7);
  });

  test("AC10: printenv sees the env assignment carried by the command string", async () => {
    const result = await _acceptanceSetupDeps.runTest(testPath, workdir, "NAX_ACC_PROBE=abc printenv NAX_ACC_PROBE");

    expect(result.output).toContain("abc");
  });

  test("AC10 boundary: the user's own quoting reaches printenv intact", async () => {
    const result = await _acceptanceSetupDeps.runTest(testPath, workdir, "NAX_ACC_PROBE='a b' printenv NAX_ACC_PROBE");

    expect(result.output).toContain("a b");
  });
});

describe("US-001: the post-run acceptance stage spawns one shell string", () => {
  function makeStageCtx(commandOverride?: string) {
    const story = makeTestStory({
      id: "US-001",
      status: "passed",
      passes: true,
      acceptanceCriteria: ["AC-1: works"],
    });
    return makeTestContext({
      workdir,
      projectDir: workdir,
      featureDir: path.join(workdir, ".nax/features/test-feature"),
      story,
      prd: makeTestPRD([story]),
      acceptanceTestPaths: [
        {
          testPath,
          packageDir: workdir,
          commandOverride,
          storyCount: 1,
          acceptanceEnabled: true,
        },
      ],
    });
  }

  test("AC12: spawns /bin/sh -c with the package's override command", async () => {
    const originalSpawn = _executorDeps.spawn;
    const spawnStub = makeSpawn(() => "1 pass\n");
    _executorDeps.spawn = spawnStub.spawn;

    try {
      const result = await acceptanceStage.execute(makeStageCtx("FOO=1 bun test {{FILE}}"));

      expect(result.action).toBe("continue");
      expect(spawnStub.calls).toHaveLength(1);
      expect(spawnStub.calls[0]?.cmd).toEqual(["/bin/sh", "-c", `FOO=1 bun test '${testPath}'`]);
      expect(spawnStub.calls[0]?.opts.cwd).toBe(workdir);
    } finally {
      _executorDeps.spawn = originalSpawn;
    }
  });

  test("AC12 boundary: without an override the spawn runs the quote-joined framework default", async () => {
    const originalSpawn = _executorDeps.spawn;
    const spawnStub = makeSpawn(() => "1 pass\n");
    _executorDeps.spawn = spawnStub.spawn;

    try {
      const result = await acceptanceStage.execute(makeStageCtx());

      expect(result.action).toBe("continue");
      expect(spawnStub.calls[0]?.cmd).toEqual(["/bin/sh", "-c", `'bun' 'test' '${testPath}' '--timeout=60000'`]);
    } finally {
      _executorDeps.spawn = originalSpawn;
    }
  });
});

// ---------------------------------------------------------------------------
// US-002: the post-run stage names a command that could not run (exit 126/127)
// instead of calling it a runner crash.
// ---------------------------------------------------------------------------

const POST_RUN_NOT_RUNNABLE_MSG = "Acceptance command could not run — check acceptance.command";
const TESTS_ERRORED_NO_AC_MSG = "Tests errored with no AC failures parsed";

describe("US-002: the post-run stage names a command that could not run (exit 126/127)", () => {
  let captured: LogEntry[];
  let unsubscribe: (() => void) | null = null;

  function makeExit127Ctx(commandOverride?: string) {
    const story = makeTestStory({
      id: "US-001",
      status: "passed",
      passes: true,
      acceptanceCriteria: ["AC-1: works"],
    });
    return makeTestContext({
      workdir,
      projectDir: workdir,
      featureDir: path.join(workdir, ".nax/features/test-feature"),
      story,
      prd: makeTestPRD([story]),
      acceptanceTestPaths: [
        {
          testPath,
          packageDir: workdir,
          commandOverride,
          storyCount: 1,
          acceptanceEnabled: true,
        },
      ],
    });
  }

  beforeEach(() => {
    resetLogger();
    initLogger({ level: "debug", suppressConsole: true });
    captured = [];
    unsubscribe = addSink((entry) => {
      captured.push(entry);
    });
  });

  afterEach(() => {
    unsubscribe?.();
    unsubscribe = null;
    resetLogger();
  });

  function entriesWithMessage(message: string): LogEntry[] {
    return captured.filter((entry) => entry.message === message);
  }

  test("AC12: exit 127 produces a 'test-runner-error' finding naming the command", async () => {
    const originalSpawn = _executorDeps.spawn;
    const spawnStub = makeSpawn(() => ({ stdout: "sh: FOO: command not found\n", exitCode: 127 }));
    _executorDeps.spawn = spawnStub.spawn;

    try {
      const ctx = makeExit127Ctx();
      const result = await acceptanceStage.execute(ctx);

      expect(result.action).toBe("fail");
      const findings = ctx.acceptanceFailures?.findings ?? [];
      expect(findings).toHaveLength(1);
      expect(findings[0]?.category).toBe("test-runner-error");
      expect(findings[0]?.message).toBe(`Acceptance command could not run (exit 127): ${spawnStub.calls[0]?.cmd[2]}`);
      expect(spawnStub.calls[0]?.cmd[2]).toBeTruthy();
    } finally {
      _executorDeps.spawn = originalSpawn;
    }
  });

  test("AC13: exit 127 logs a distinct error from stage 'acceptance' with storyId first, cmd, exitCode, and packageDir", async () => {
    const originalSpawn = _executorDeps.spawn;
    const spawnStub = makeSpawn(() => ({ stdout: "sh: FOO: command not found\n", exitCode: 127 }));
    _executorDeps.spawn = spawnStub.spawn;

    try {
      const ctx = makeExit127Ctx();
      await acceptanceStage.execute(ctx);

      const errors = captured.filter(
        (entry) =>
          entry.level === "error" && entry.stage === "acceptance" && entry.message === POST_RUN_NOT_RUNNABLE_MSG,
      );
      expect(errors).toHaveLength(1);
      const data = errors[0]?.data ?? {};
      expect(Object.keys(data)[0]).toBe("storyId");
      expect(data.exitCode).toBe(127);
      expect(data.cmd).toBe(spawnStub.calls[0]?.cmd[2]);
      expect(data.packageDir).toBe(workdir);
    } finally {
      _executorDeps.spawn = originalSpawn;
    }
  });

  test("AC13 boundary: the generic 'Tests errored with no AC failures parsed' is NOT logged on exit 127", async () => {
    const originalSpawn = _executorDeps.spawn;
    _executorDeps.spawn = makeSpawn(() => ({ stdout: "sh: FOO: command not found\n", exitCode: 127 })).spawn;

    try {
      await acceptanceStage.execute(makeExit127Ctx());
      expect(entriesWithMessage(TESTS_ERRORED_NO_AC_MSG)).toHaveLength(0);
    } finally {
      _executorDeps.spawn = originalSpawn;
    }
  });

  test("AC14: failedACs is ['AC-ERROR'] and failedPackages has one entry for the package — fix routing input unchanged", async () => {
    const originalSpawn = _executorDeps.spawn;
    _executorDeps.spawn = makeSpawn(() => ({ stdout: "sh: FOO: command not found\n", exitCode: 127 })).spawn;

    try {
      const ctx = makeExit127Ctx();
      const result = await acceptanceStage.execute(ctx);

      expect(result.action).toBe("fail");
      expect(ctx.acceptanceFailures?.failedACs).toEqual(["AC-ERROR"]);
      expect(ctx.acceptanceFailures?.failedPackages).toEqual([
        expect.objectContaining({
          testPath,
          packageDir: workdir,
          failedACs: ["AC-ERROR"],
        }),
      ]);
      expect(ctx.acceptanceFailures?.failedPackages).toHaveLength(1);
    } finally {
      _executorDeps.spawn = originalSpawn;
    }
  });

  test("AC14 boundary: exit 126 follows the same override path as 127", async () => {
    const originalSpawn = _executorDeps.spawn;
    const spawnStub = makeSpawn(() => ({ stdout: "sh: FOO: Permission denied\n", exitCode: 126 }));
    _executorDeps.spawn = spawnStub.spawn;

    try {
      const ctx = makeExit127Ctx();
      await acceptanceStage.execute(ctx);

      const errors = captured.filter(
        (entry) =>
          entry.level === "error" && entry.stage === "acceptance" && entry.message === POST_RUN_NOT_RUNNABLE_MSG,
      );
      expect(errors).toHaveLength(1);
      expect(errors[0]?.data?.exitCode).toBe(126);

      const findings = ctx.acceptanceFailures?.findings ?? [];
      expect(findings).toHaveLength(1);
      expect(findings[0]?.category).toBe("test-runner-error");
      expect(findings[0]?.message).toBe(`Acceptance command could not run (exit 126): ${spawnStub.calls[0]?.cmd[2]}`);
    } finally {
      _executorDeps.spawn = originalSpawn;
    }
  });

  test("AC15: a non-126/127 crash (exit 1) still produces the original 'Test runner crashed before test bodies ran' finding", async () => {
    const originalSpawn = _executorDeps.spawn;
    _executorDeps.spawn = makeSpawn(() => ({ stdout: "SyntaxError: Unexpected token\n", exitCode: 1 })).spawn;

    try {
      const ctx = makeExit127Ctx();
      await acceptanceStage.execute(ctx);

      const findings = ctx.acceptanceFailures?.findings ?? [];
      expect(findings).toHaveLength(1);
      expect(findings[0]?.category).toBe("test-runner-error");
      expect(findings[0]?.message).toBe("Test runner crashed before test bodies ran");

      expect(entriesWithMessage(POST_RUN_NOT_RUNNABLE_MSG)).toHaveLength(0);
    } finally {
      _executorDeps.spawn = originalSpawn;
    }
  });
});
