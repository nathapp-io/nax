/**
 * US-001 — the run temp root: `<parent>/<runId>` under a shared `/tmp/nax`.
 *
 * A flat `/tmp/nax-<runId>` root is hard to find and list, so runs now nest
 * under one `/tmp/nax` parent. That parent is shared, so it cannot be created
 * once and trusted: a `/tmp/nax` made by one OS user is not writable by
 * another. Instead the parent is re-resolved on every call from three host
 * facts the `_sessionTmpDeps` seam exposes — what `lstat("/tmp/nax")` reports,
 * whether `access` succeeds, and the uid. Absence is the ordinary shared-parent
 * case (the launcher's recursive mkdir creates it), and so is a real directory
 * the current user can write and search; anything else — a symlink, a
 * non-directory, a failed `access`, or an `lstat` error other than ENOENT —
 * falls back to `/tmp/nax-<uid>`.
 *
 * Imported through the `@/sandbox` BARREL, not the leaf module: the story's
 * interface promises `runTmpRoot`, `sessionTmpDir` and `_sessionTmpDeps` are
 * reachable from the barrel, and a leaf import would not prove that.
 */
import { describe, expect, test } from "bun:test";
import { _sessionTmpDeps, runTmpRoot, sessionTmpDir } from "#src/sandbox/index";
import { stubSessionTmpDeps, withDepsRestore } from "#test/helpers/index";

/** The shared parent every resolvable `/tmp/nax` case nests under. */
const PARENT = "/tmp/nax";

describe("US-001 — run temp root resolution (src/sandbox/session-tmp)", () => {
  withDepsRestore(_sessionTmpDeps);

  test("US-001 AC1: returns /tmp/nax/run-1 when /tmp/nax is absent", () => {
    stubSessionTmpDeps(_sessionTmpDeps, { parent: "ENOENT" });

    expect(runTmpRoot("run-1")).toBe("/tmp/nax/run-1");
  });

  test("US-001 AC1 boundary: the parent is re-resolved on every call, never cached", () => {
    stubSessionTmpDeps(_sessionTmpDeps, { parent: "ENOENT" });
    expect(runTmpRoot("run-1")).toBe("/tmp/nax/run-1");

    // The host changes between calls — /tmp/nax appeared as a symlink another
    // user owns — so the same run id has to land on the fallback parent now.
    stubSessionTmpDeps(_sessionTmpDeps, { parent: "symlink", uid: 501 });
    expect(runTmpRoot("run-1")).toBe("/tmp/nax-501/run-1");
  });

  test("US-001 AC2: returns /tmp/nax/run-1 when /tmp/nax is a writable directory", () => {
    stubSessionTmpDeps(_sessionTmpDeps, { parent: "directory", access: "ok" });

    expect(runTmpRoot("run-1")).toBe("/tmp/nax/run-1");
  });

  test("US-001 AC2 boundary: a run id already inside [A-Za-z0-9_-] is used verbatim", () => {
    stubSessionTmpDeps(_sessionTmpDeps, { parent: "directory", access: "ok" });

    expect(runTmpRoot("Run_1-x")).toBe("/tmp/nax/Run_1-x");
  });

  test("US-001 AC3: falls back to /tmp/nax-501/run-1 when access throws EACCES", () => {
    stubSessionTmpDeps(_sessionTmpDeps, { parent: "directory", access: "EACCES", uid: 501 });

    expect(runTmpRoot("run-1")).toBe("/tmp/nax-501/run-1");
  });

  test("US-001 AC3 boundary: the fallback parent spells the uid verbatim, zero included", () => {
    stubSessionTmpDeps(_sessionTmpDeps, { parent: "directory", access: "EACCES", uid: 0 });

    expect(runTmpRoot("run-1")).toBe("/tmp/nax-0/run-1");
  });

  test("US-001 AC4: falls back when /tmp/nax is a symbolic link", () => {
    stubSessionTmpDeps(_sessionTmpDeps, { parent: "symlink", access: "ok", uid: 501 });

    expect(runTmpRoot("run-1")).toBe("/tmp/nax-501/run-1");
  });

  test("US-001 AC4 boundary: a symlink falls back even when access would succeed", () => {
    // Writing through someone else's symlink is the case the fallback exists
    // for, so the link check cannot wait on the access result.
    stubSessionTmpDeps(_sessionTmpDeps, { parent: "symlink", access: "EACCES", uid: 501 });

    expect(runTmpRoot("run-1")).toBe("/tmp/nax-501/run-1");
  });

  test("US-001 AC5: falls back when /tmp/nax is a regular file", () => {
    stubSessionTmpDeps(_sessionTmpDeps, { parent: "file", uid: 501 });

    expect(runTmpRoot("run-1")).toBe("/tmp/nax-501/run-1");
  });

  test("US-001 AC5 boundary: a regular file is not a parent even when access succeeds", () => {
    // Writability is not what disqualifies it — not being a directory is.
    stubSessionTmpDeps(_sessionTmpDeps, { parent: "file", access: "ok", uid: 501 });

    expect(runTmpRoot("run-1")).toBe("/tmp/nax-501/run-1");
  });

  test("US-001 AC6: falls back when lstat fails with EACCES", () => {
    stubSessionTmpDeps(_sessionTmpDeps, { parent: "EACCES", uid: 501 });

    expect(runTmpRoot("run-1")).toBe("/tmp/nax-501/run-1");
  });

  test("US-001 AC6 boundary: any lstat failure other than ENOENT falls back too", () => {
    // ENOENT is the one failure that means "create /tmp/nax"; every other errno
    // means the path is there in some shape nax cannot vouch for.
    stubSessionTmpDeps(_sessionTmpDeps, { parent: "ELOOP", uid: 501 });

    expect(runTmpRoot("run-1")).toBe("/tmp/nax-501/run-1");
  });

  test("US-001 AC7: sessionTmpDir sanitizes both parts under the resolved parent", () => {
    stubSessionTmpDeps(_sessionTmpDeps, { parent: "ENOENT" });

    expect(sessionTmpDir("run-1", "US 001/impl")).toBe("/tmp/nax/run-1/US_001_impl");
  });

  test("US-001 AC7 boundary: every separator in a nested session name is neutralised", () => {
    stubSessionTmpDeps(_sessionTmpDeps, { parent: "ENOENT" });

    expect(sessionTmpDir("run-1", "a/b")).toBe("/tmp/nax/run-1/a_b");
    expect(sessionTmpDir("run-1", "a/b/c")).toBe("/tmp/nax/run-1/a_b_c");
  });

  test("US-001 AC7 boundary: a traversal-shaped session name stays one flat segment", () => {
    stubSessionTmpDeps(_sessionTmpDeps, { parent: "ENOENT" });

    const segment = sessionTmpDir("run-1", "../../etc").slice(`${runTmpRoot("run-1")}/`.length);

    // No separator survives sanitisation, so the session part can never name
    // anything outside the run root.
    expect(segment).not.toContain("/");
    expect(segment).not.toBe("..");
  });

  test("US-001 AC7: the fallback layout sanitizes exactly the same way", () => {
    stubSessionTmpDeps(_sessionTmpDeps, { parent: "symlink", uid: 501 });

    expect(sessionTmpDir("run-1", "US 001/impl")).toBe("/tmp/nax-501/run-1/US_001_impl");
  });

  test("US-001 AC8: a traversal-shaped run id stays one flat segment under the parent", () => {
    stubSessionTmpDeps(_sessionTmpDeps, { parent: "ENOENT" });

    const root = runTmpRoot("../x");

    expect(root).toBe("/tmp/nax/.._x");
    // No separator survives sanitisation, so nothing follows the parent but the
    // sanitised run id itself.
    expect(root.slice(`${PARENT}/`.length)).not.toContain("/");
  });

  test("US-001 AC8 boundary: a deeper traversal run id cannot escape the parent either", () => {
    stubSessionTmpDeps(_sessionTmpDeps, { parent: "ENOENT" });

    expect(runTmpRoot("../../etc")).toBe("/tmp/nax/.._.._etc");
  });

  test("US-001 AC7/AC8: the session directory is a child of that run's own root", () => {
    stubSessionTmpDeps(_sessionTmpDeps, { parent: "ENOENT" });

    expect(sessionTmpDir("run-1", "US-001-implementer").startsWith(`${runTmpRoot("run-1")}/`)).toBe(true);
    // ...and a sibling run's root is never a prefix of it.
    expect(sessionTmpDir("run-2", "x").startsWith(`${runTmpRoot("run-1")}/`)).toBe(false);
  });
});
