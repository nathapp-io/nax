/**
 * A confined-run fixture, not a test the suite collects: `*.fixture.ts` is
 * passed to `bun test` as an explicit `./` path by
 * `scripts/run-confined-tests.ts`, while `bun test ./test/unit/ ./test/integration/`
 * never picks it up.
 *
 * It writes under `makeTempDir()`, which resolves through `os.tmpdir()` and so
 * through the runner's exported `$TMPDIR` — the run's own temp root, which the
 * confined policy grants. A confined run of this file must exit 0; together
 * with `writes-literal-tmp.fixture.ts` it is the pair that proves the gate
 * distinguishes the two, rather than failing everything.
 */
import { expect, test } from "bun:test";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "#test/helpers/index";

test("writes under makeTempDir()", async () => {
  const dir = makeTempDir("nax-confined-fixture-");
  try {
    await Bun.write(join(dir, "wrote.txt"), "written\n");
    expect(await Bun.file(join(dir, "wrote.txt")).text()).toBe("written\n");
  } finally {
    cleanupTempDir(dir);
  }
});
