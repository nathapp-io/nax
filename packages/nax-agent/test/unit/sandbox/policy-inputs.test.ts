import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { listCredentialFiles, listNaxEntries, resolveGitLayout } from "@nathapp/nax-agent";
import { policyInputsModule as policyInputs, realOrRaw } from "@nathapp/nax-agent/internal";
import { cleanupTempDir, makeTempDir } from "#test/helpers/index";

let base: string;
beforeEach(() => {
  base = realOrRaw(makeTempDir("sbx-inputs-"));
});
afterEach(() => cleanupTempDir(base));

function git(args: string[], cwd: string): void {
  const r = Bun.spawnSync(["git", "-c", "user.email=a@b", "-c", "user.name=a", ...args], { cwd });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
}

describe("resolveGitLayout", () => {
  test("not a repo -> none", async () => {
    expect(await resolveGitLayout(base)).toEqual({ kind: "none" });
  });

  test("main checkout -> main with an absolute git dir", async () => {
    git(["init", "-q", "-b", "main"], base);
    expect(await resolveGitLayout(base)).toEqual({ kind: "main", gitDir: join(base, ".git") });
  });

  test("a nax-style worktree -> worktree with gitDir under the common dir", async () => {
    git(["init", "-q", "-b", "main"], base);
    writeFileSync(join(base, "a.txt"), "a");
    git(["add", "-A"], base);
    git(["commit", "-qm", "seed"], base);
    git(["worktree", "add", "-q", ".nax-wt/US-001", "-b", "wt"], base);
    const layout = await resolveGitLayout(join(base, ".nax-wt", "US-001"));
    expect(layout).toEqual({
      kind: "worktree",
      gitDir: join(base, ".git", "worktrees", "US-001"),
      commonDir: join(base, ".git"),
    });
  });
});

describe("listNaxEntries", () => {
  test("every top-level entry under .nax, files and directories alike", async () => {
    mkdirSync(join(base, ".nax", "features", "a"), { recursive: true });
    mkdirSync(join(base, ".nax", "rules"), { recursive: true });
    writeFileSync(join(base, ".nax", "config.json"), "{}");
    const names = (await listNaxEntries(base, ".nax")).sort((a, b) => a.localeCompare(b));
    expect(names).toEqual(["config.json", "features", "rules"]);
  });

  test("F1: an entry with a glob character is skipped (it would poison every policy build)", async () => {
    mkdirSync(join(base, ".nax", "ok"), { recursive: true });
    mkdirSync(join(base, ".nax", "x*"), { recursive: true });
    mkdirSync(join(base, ".nax", "a[1]"), { recursive: true });
    expect(await listNaxEntries(base, ".nax")).toEqual(["ok"]);
  });

  test("no .nax directory -> empty", async () => {
    expect(await listNaxEntries(base, ".nax")).toEqual([]);
  });
});

describe("listCredentialFiles", () => {
  test("every credentials* file in the credential dir, as literals", async () => {
    const dir = makeTempDir("sbx-cred-");
    mkdirSync(dir, { recursive: true });
    const made = ["credentials", "credentials-bak-2", "config.json"].map((n) => join(dir, n));
    try {
      for (const f of made) writeFileSync(f, "{}");
      const files = await listCredentialFiles(dir);
      expect(files).toContain(join(dir, "credentials"));
      expect(files).toContain(join(dir, "credentials-bak-2"));
      expect(files).not.toContain(join(dir, "config.json"));
    } finally {
      for (const f of made) rmSync(f, { force: true });
      cleanupTempDir(dir);
    }
  });
});

describe("runTempRoots (US-002)", () => {
  /**
   * Called through the module namespace with an OPTIONAL call on purpose: in
   * the RED state `runTempRoots` has no export yet, and a named import of a
   * missing export is a load-time SyntaxError that would take this whole file
   * (including `resolveGitLayout`'s and `listNaxEntries`'s tests) down with it,
   * proving nothing. `policyInputs.runTempRoots?.(…)` yields `undefined` when
   * the function is absent, so the failure lands on the assertion below.
   */
  const run = (opts: { runTmpRoot: string; tmpdir: string }): readonly string[] | undefined =>
    policyInputs.runTempRoots?.(opts);

  test("US-002 AC3: a tmpdir outside /tmp is kept, ahead of the run root", () => {
    expect(run({ runTmpRoot: "/tmp/nax/r1", tmpdir: "/var/folders/x/T" })).toEqual(["/var/folders/x/T", "/tmp/nax/r1"]);
  });

  test("US-002 AC3 boundary: any tmpdir outside /tmp is kept, /var included", () => {
    expect(run({ runTmpRoot: "/tmp/nax/r1", tmpdir: "/var" })).toEqual(["/var", "/tmp/nax/r1"]);
  });

  test("US-002 AC4: a tmpdir of /tmp is dropped — keeping it would re-grant all of /tmp", () => {
    expect(run({ runTmpRoot: "/tmp/nax/r1", tmpdir: "/tmp" })).toEqual(["/tmp/nax/r1"]);
  });

  test("US-002 AC4 boundary: a tmpdir merely under /tmp is dropped too", () => {
    expect(run({ runTmpRoot: "/tmp/nax/r1", tmpdir: "/tmp/nax" })).toEqual(["/tmp/nax/r1"]);
  });

  test("US-002 AC5: a tmpdir nested under /tmp is dropped", () => {
    expect(run({ runTmpRoot: "/tmp/nax/r1", tmpdir: "/tmp/user-tmp" })).toEqual(["/tmp/nax/r1"]);
  });

  test("US-002 AC5 boundary: a deeper path under /tmp is dropped as well", () => {
    expect(run({ runTmpRoot: "/tmp/nax/r1", tmpdir: "/tmp/user-tmp/deeper" })).toEqual(["/tmp/nax/r1"]);
  });

  test("US-002 AC6: the macOS spelling /private/tmp is dropped", () => {
    expect(run({ runTmpRoot: "/tmp/nax/r1", tmpdir: "/private/tmp" })).toEqual(["/tmp/nax/r1"]);
  });

  test("US-002 AC6 boundary: a path under /private/tmp is dropped as well", () => {
    expect(run({ runTmpRoot: "/tmp/nax/r1", tmpdir: "/private/tmp/other" })).toEqual(["/tmp/nax/r1"]);
  });
});
