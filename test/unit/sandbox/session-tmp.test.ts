/**
 * US-004 — the per-session temp directory names, under a run-owned root.
 *
 * A stray `/tmp/tsconfig.json` survived an NBF restore and turned a later
 * story's full-suite gate red, so launcher-driven Bash/Exec commands get an
 * isolated temp directory (`/tmp/nax-<runId>/<sessionName>`) that the run
 * deletes when it ends.
 *
 * Imported through the `@/sandbox` BARREL, not the leaf module: the story's
 * interface promises `sessionTmpDir` / `runTmpRoot` are reachable from the
 * barrel, and a leaf import would not prove that.
 */
import { describe, expect, test } from "bun:test";
import * as sandbox from "@/sandbox";

const RUN_PREFIX = "/tmp/nax-run-1/";

describe("US-004 — session temp directory naming (src/sandbox/session-tmp)", () => {
  test("US-004 AC1: sessionTmpDir nests the session name under the run root", () => {
    expect(sandbox.sessionTmpDir("run-1", "US-001-implementer")).toBe("/tmp/nax-run-1/US-001-implementer");
  });

  test("US-004 AC2: a path separator in the session name becomes an underscore", () => {
    expect(sandbox.sessionTmpDir("run-1", "a/b")).toBe("/tmp/nax-run-1/a_b");
  });

  test("US-004 AC3: runTmpRoot is the per-run parent under /tmp", () => {
    expect(sandbox.runTmpRoot("run-1")).toBe("/tmp/nax-run-1");
  });

  test("US-004 AC2 boundary: every separator in a nested session name is neutralised", () => {
    expect(sandbox.sessionTmpDir("run-1", "a/b/c")).toBe("/tmp/nax-run-1/a_b_c");
  });

  test("US-004 AC2 boundary: a space in the session name becomes an underscore", () => {
    expect(sandbox.sessionTmpDir("run-1", "US 001")).toBe("/tmp/nax-run-1/US_001");
  });

  test("US-004 AC2 boundary: a traversal-shaped session name cannot escape the run root", () => {
    const dir = sandbox.sessionTmpDir("run-1", "../../etc");
    // Everything after the run prefix is one flat segment: no separator survives
    // sanitisation, so the result can never name anything outside the run root.
    expect(dir.startsWith(RUN_PREFIX)).toBe(true);
    expect(dir.slice(RUN_PREFIX.length)).not.toContain("/");
    expect(dir.slice(RUN_PREFIX.length)).not.toContain(".");
  });

  test("US-004 AC1/AC3: the session dir is a child of the run root for the same runId", () => {
    expect(sandbox.sessionTmpDir("run-1", "US-001-implementer").startsWith(`${sandbox.runTmpRoot("run-1")}/`)).toBe(
      true,
    );
  });
});
