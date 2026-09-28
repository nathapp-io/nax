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
import { initLogger, resetLogger } from "@/logger";
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
