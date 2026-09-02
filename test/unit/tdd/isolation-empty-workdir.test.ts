// RE-ARCH: keep
import { afterEach, describe, expect, test } from "bun:test";
import { makeSpawn } from "@test/helpers";
import { _isolationDeps, verifyImplementerIsolation, verifyTestWriterIsolation } from "@/tdd/isolation";

const realSpawn = _isolationDeps.spawn;
afterEach(() => {
  _isolationDeps.spawn = realSpawn;
});

/**
 * An empty workdir must not silently become process.cwd().
 *
 * packageView.packageDir is "" for the root package of every single-package
 * repo (see toRelativeKey in runtime/packages.ts), and Bun.spawn treats cwd:""
 * as unset. Running nax from one repository against another with `-d` therefore
 * ran the isolation diff in the *launching* repo, where the target repo's SHA is
 * a bad object — every story failed with "fatal: bad object <sha>". See
 * docs/superpowers/specs/2026-09-02-plan-4-results.md.
 */
describe("isolation git calls reject an empty workdir", () => {
  test("verifyImplementerIsolation rejects rather than falling back to process.cwd()", async () => {
    const stub = makeSpawn(() => "src/foo.ts\n");
    _isolationDeps.spawn = stub.spawn;

    await expect(verifyImplementerIsolation("", "abc123")).rejects.toThrow(/workdir/i);
    expect(stub.calls).toHaveLength(0);
  });

  test("verifyTestWriterIsolation rejects rather than falling back to process.cwd()", async () => {
    const stub = makeSpawn(() => "src/foo.ts\n");
    _isolationDeps.spawn = stub.spawn;

    await expect(verifyTestWriterIsolation("", "abc123")).rejects.toThrow(/workdir/i);
    expect(stub.calls).toHaveLength(0);
  });

  test("a real workdir is passed through to git as cwd", async () => {
    const stub = makeSpawn(() => "");
    _isolationDeps.spawn = stub.spawn;

    await verifyImplementerIsolation("/tmp/some-repo", "abc123");

    expect(stub.calls.length).toBeGreaterThan(0);
    for (const call of stub.calls) {
      expect(call.opts.cwd).toBe("/tmp/some-repo");
    }
  });
});
