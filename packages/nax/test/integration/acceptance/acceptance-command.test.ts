/**
 * US-001: an acceptance command is ONE shell string, executed through
 * `/bin/sh -c`.
 *
 * These tests deliberately cross the module boundary: the string the builder
 * produces has to survive a real shell, and the runner has to spawn it as
 * `["/bin/sh", "-c", cmd]` instead of splitting it back into argv words.
 *
 * The surviving seam is `executeWithTimeout` (`src/verification`), which is what
 * every acceptance runner delegated to. pipeline-post-run-delete US-005 deleted
 * the acceptance setup stage and `_acceptanceSetupDeps.runTest`, so the tests
 * that drove that wrapper now drive the seam it wrapped; the two post-run
 * acceptance-stage describes went with the stage.
 *
 * The tests reach the real `/bin/sh` — that IS the behaviour under test (a
 * leading `VAR=value` assignment only survives if the command reaches the shell
 * unquoted), and every command they run (`true`, `printenv`, `echo`, `exit`) is
 * a POSIX built-in inside a temp workdir, so nothing leaves the machine.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import path from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { executeWithTimeout } from "@/verification";

let workdir: string;
let testPath: string;

beforeEach(async () => {
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
});

/** The acceptance runner handed the built command to this exact call. */
function runCommand(command: string) {
  return executeWithTimeout(command, 30, undefined, { cwd: workdir });
}

describe("US-001: the acceptance command reaches the real shell", () => {
  test("AC9: a leading env assignment is not quoted, so the command resolves with exitCode 0", async () => {
    const result = await runCommand("NAX_ACC_PROBE=1 true");

    expect(result.exitCode).toBe(0);
  });

  test("AC9 boundary: && reaches the shell as an operator, not as a quoted word", async () => {
    const result = await runCommand("NAX_ACC_PROBE=1 true && echo chained");

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("chained");
  });

  test("AC9 boundary: the shell's own exit code is reported unchanged", async () => {
    const result = await runCommand("NAX_ACC_PROBE=1 exit 7");

    expect(result.exitCode).toBe(7);
  });

  test("AC10: printenv sees the env assignment carried by the command string", async () => {
    const result = await runCommand("NAX_ACC_PROBE=abc printenv NAX_ACC_PROBE");

    expect(result.output).toContain("abc");
  });

  test("AC10 boundary: the user's own quoting reaches printenv intact", async () => {
    const result = await runCommand("NAX_ACC_PROBE='a b' printenv NAX_ACC_PROBE");

    expect(result.output).toContain("a b");
  });
});
