/**
 * A confined-run fixture, not a test the suite collects: `*.fixture.ts` is
 * passed to `bun test` as an explicit `./` path by
 * `scripts/run-confined-tests.ts`, while `bun test ./test/unit/ ./test/integration/`
 * never picks it up.
 *
 * It writes under a LITERAL `/tmp/...` path, which a confined session's sandbox
 * denies (nax#2301: the shared temp roots are not write roots), so a confined
 * run of this file must exit non-zero. That failure is the runner's regression
 * gate: if this file ever passes confined, the policy stopped confining temp.
 * The file is removed on the (unsandboxed) path that would succeed.
 */
import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";

test("writes under a literal /tmp path", () => {
  const path = `/tmp/nax-confined-probe-${randomUUID()}`;
  writeFileSync(path, "written\n");
  try {
    expect(readFileSync(path, "utf8")).toBe("written\n");
  } finally {
    rmSync(path, { force: true });
  }
});
