import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeNaxConfig } from "@test/helpers";
import { resolvePermissions } from "@/config/permissions";
import { compileToolPolicy, createCodingToolRuntime, DEFAULT_TOOL_MAX_FILE_BYTES, deleteTool } from "@/tools";
import { gitWithTimeout } from "@/utils/git";

let root: string;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "nax-delete-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "tracked.ts"), "export const a = 1;\n");
  writeFileSync(join(root, "src", "also-tracked.ts"), "export const b = 2;\n");
  symlinkSync("src/tracked.ts", join(root, "tracked-link.ts"));
  symlinkSync("src", join(root, "src-link"));
  await gitWithTimeout(["init", "-q", "."], root, 30_000);
  await gitWithTimeout(["config", "user.email", "t@example.com"], root, 30_000);
  await gitWithTimeout(["config", "user.name", "t"], root, 30_000);
  await gitWithTimeout(["add", "-A"], root, 30_000);
  await gitWithTimeout(["commit", "-q", "-m", "init"], root, 30_000);
});

function ctx(paths: string[], denyPaths?: string[]) {
  return {
    root,
    resolvedPaths: paths,
    maxBytes: 10_000,
    maxFileBytes: DEFAULT_TOOL_MAX_FILE_BYTES,
    ...(denyPaths !== undefined ? { denyPaths } : {}),
  };
}

describe("deleteTool", () => {
  test("deletes a tracked file and names the staging step", async () => {
    const target = join(root, "src", "tracked.ts");
    const res = await deleteTool.run({ path: "src/tracked.ts" }, ctx([target]));
    expect(res.isError).toBeFalsy();
    expect(existsSync(target)).toBe(false);
    expect(res.content).toContain("GitCommit");
  });

  test("deletes a tracked symlink without deleting its target", async () => {
    const target = join(root, "src", "tracked.ts");
    const link = join(root, "tracked-link.ts");

    const res = await deleteTool.run({ path: "tracked-link.ts" }, ctx([target]));

    expect(res.isError).toBeFalsy();
    expect(existsSync(link)).toBe(false);
    expect(existsSync(target)).toBe(true);
  });

  test("deletes a tracked symlink to a directory", async () => {
    const link = join(root, "src-link");

    const res = await deleteTool.run({ path: "src-link" }, ctx([join(root, "src")]));

    expect(res.isError).toBeFalsy();
    expect(existsSync(link)).toBe(false);
    expect(existsSync(join(root, "src"))).toBe(true);
  });

  test("deletes an untracked-but-not-ignored file (nax#1972)", async () => {
    // Agent scratch/work-in-progress: written this session, never committed,
    // and nobody wrote a .gitignore rule for it either. Both untracked
    // classes are equally unrecoverable from git history; the distinction is
    // declared intent, and nobody declared any here -- so it is deletable.
    writeFileSync(join(root, "src", "scratch.ts"), "x\n");
    const target = join(root, "src", "scratch.ts");
    const res = await deleteTool.run({ path: "src/scratch.ts" }, ctx([target]));
    expect(res.isError).toBeFalsy();
    expect(existsSync(target)).toBe(false);
  });

  test("refuses a gitignored file and explains why, without telling the agent to commit it", async () => {
    writeFileSync(join(root, ".gitignore"), "*.local\n");
    await gitWithTimeout(["add", ".gitignore"], root, 30_000);
    await gitWithTimeout(["commit", "-q", "-m", "add gitignore"], root, 30_000);
    writeFileSync(join(root, "src", "secrets.local"), "x\n");
    const target = join(root, "src", "secrets.local");
    const res = await deleteTool.run({ path: "src/secrets.local" }, ctx([target]));
    expect(res.isError).toBe(true);
    expect(res.content).toContain("gitignored");
    expect(res.content).not.toContain("commit it first");
    expect(existsSync(target)).toBe(true);
  });

  test("refuses a file ignored by a nested subdirectory .gitignore", async () => {
    mkdirSync(join(root, "sub"), { recursive: true });
    writeFileSync(join(root, "sub", ".gitignore"), "ignored-here.ts\n");
    await gitWithTimeout(["add", "sub/.gitignore"], root, 30_000);
    await gitWithTimeout(["commit", "-q", "-m", "add nested gitignore"], root, 30_000);
    writeFileSync(join(root, "sub", "ignored-here.ts"), "x\n");
    const target = join(root, "sub", "ignored-here.ts");
    const res = await deleteTool.run({ path: "sub/ignored-here.ts" }, ctx([target]));
    expect(res.isError).toBe(true);
    expect(res.content).toContain("gitignored");
    expect(existsSync(target)).toBe(true);
  });

  // nax#1972: `check-ignore` exits 1 for "not ignored" and 128 when git could
  // not answer at all. Treating those the same makes a broken or absent
  // repository the most permissive environment Delete has, which inverts the
  // guard. The pre-#1972 code was deliberately fail-closed here -- "untracked"
  // and "git failed" shared one refusal on purpose -- and that survives the
  // three-class rewrite: only a definitive "not ignored" is an allow.
  test("refuses an untracked file when git cannot answer, rather than failing open", async () => {
    const outside = mkdtempSync(join(tmpdir(), "nax-delete-nogit-"));
    const target = join(outside, "scratch.ts");
    writeFileSync(target, "export const x = 1;\n");

    const res = await deleteTool.run(
      { path: "scratch.ts" },
      { root: outside, resolvedPaths: [target], maxBytes: 10_000, maxFileBytes: DEFAULT_TOOL_MAX_FILE_BYTES },
    );

    expect(res.isError).toBe(true);
    expect(existsSync(target)).toBe(true);
  });

  test("refuses a directory", async () => {
    const target = join(root, "src");
    const res = await deleteTool.run({ path: "src" }, ctx([target]));
    expect(res.isError).toBe(true);
    expect(res.content).toContain("directory");
    expect(existsSync(target)).toBe(true);
  });

  test("refuses a missing path rather than reporting success", async () => {
    const res = await deleteTool.run({ path: "src/nope.ts" }, ctx([join(root, "src", "nope.ts")]));
    expect(res.isError).toBe(true);
    expect(res.content).toContain("does not exist");
  });

  // nax#1972: there used to be a unit-level ".git/index is refused" test
  // here, calling deleteTool.run directly. That no longer pins anything real
  // -- Delete itself carries no .git-specific logic (nax#1943 put that
  // exclusively in resolveWithin, src/tools/policy.ts), and check-ignore
  // does not treat .git/index as ignored, so calling the tool directly with
  // a hand-built ctx now deletes it. That is not a regression: no real call
  // path reaches Delete with a .git/ path, because resolveWithin refuses it
  // before any tool runs. The pin for that lives at the policy/runtime
  // layer, in delete-wiring.test.ts, where it exercises the actual guard.

  test("errors when no path was resolved", async () => {
    const res = await deleteTool.run({ path: "src/tracked.ts" }, ctx([]));
    expect(res.isError).toBe(true);
  });

  test("refuses a tracked file matched by denyPaths, ahead of the tracked/ignored logic", async () => {
    const target = join(root, "src", "tracked.ts");
    const res = await deleteTool.run({ path: "src/tracked.ts" }, ctx([target], ["src/tracked.ts"]));
    expect(res.isError).toBe(true);
    expect(res.content).toContain("denyPaths");
    expect(existsSync(target)).toBe(true);
  });

  // nax#1972: denyPaths matched the raw `input.path` string while the policy
  // resolves and canonicalizes. Any alternate spelling of the same entry --
  // "./x", "x//y", a traversal, or an absolute path -- therefore reached the
  // deletion while the denylist believed it had refused it. A denylist that
  // can be spelled around is decorative.
  test.each([["./src/tracked.ts"], ["src//tracked.ts"], ["src/../src/tracked.ts"]])(
    "denyPaths refuses %s, the same entry spelled differently",
    async (spelling) => {
      const target = join(root, "src", "tracked.ts");
      const res = await deleteTool.run({ path: spelling }, { ...ctx([target]), denyPaths: ["src/tracked.ts"] });

      expect(res.isError).toBe(true);
      expect(existsSync(target)).toBe(true);
    },
  );

  // nax#1972: on a case-insensitive filesystem (macOS and Windows defaults)
  // ".ENV" opens the very same inode as ".env", but `resolve`/`relative`
  // preserve the caller's spelling, so a case-sensitive denylist compare let
  // the agent delete a denied file by shouting its name. Reproduced before
  // this test existed: denyPaths [".env"] + Delete ".ENV" removed .env and
  // reported success. Matching is now case-insensitive everywhere -- a
  // denylist that over-refuses a genuinely distinct ".ENV" on a
  // case-sensitive filesystem fails in the safe direction; this one did not.
  test("denyPaths refuses a case variant of a denied path", async () => {
    const target = join(root, "src", "TRACKED.ts");
    const res = await deleteTool.run({ path: "src/TRACKED.ts" }, { ...ctx([target]), denyPaths: ["src/tracked.ts"] });

    expect(res.isError).toBe(true);
    expect(existsSync(join(root, "src", "tracked.ts"))).toBe(true);
  });

  test("denyPaths supports a glob", async () => {
    const target = join(root, "src", "also-tracked.ts");
    const res = await deleteTool.run({ path: "src/also-tracked.ts" }, ctx([target], ["src/**"]));
    expect(res.isError).toBe(true);
    expect(res.content).toContain("denyPaths");
    expect(existsSync(target)).toBe(true);
  });

  test("denyPaths that does not match the path leaves normal deletion rules in force", async () => {
    const target = join(root, "src", "tracked.ts");
    const res = await deleteTool.run({ path: "src/tracked.ts" }, ctx([target], ["other/**"]));
    expect(res.isError).toBeFalsy();
    expect(existsSync(target)).toBe(false);
  });

  test("declares its path field so the policy can gate it", () => {
    expect(deleteTool.scope.pathFields).toEqual(["path"]);
  });
});

describe("Delete wiring", () => {
  test("the unrestricted profile grants Delete", () => {
    // makeNaxConfig, not a raw literal: `.nax/rules/test-helpers.md` forbids
    // re-implementing shared fixtures inline, and a bare object literal does
    // not narrow permissionProfile to its union type.
    const { toolGrants } = resolvePermissions(
      makeNaxConfig({ execution: { permissionProfile: "unrestricted" } }),
      "run",
    );
    expect((toolGrants ?? []).map((g) => g.tool)).toContain("Delete");
  });

  test("the safe profile does NOT grant Delete", () => {
    const { toolGrants } = resolvePermissions(makeNaxConfig({ execution: { permissionProfile: "safe" } }), "run");
    expect((toolGrants ?? []).map((g) => g.tool)).not.toContain("Delete");
  });

  test("a declared Delete reaches the tool through the runtime and deletes", async () => {
    const policy = compileToolPolicy([{ tool: "Delete", patterns: ["*"] }], root);
    const runtime = createCodingToolRuntime({ policy });
    expect(runtime.advertised(["Delete"]).map((t) => t.name)).toEqual(["Delete"]);

    const outcome = await runtime.callTool("Delete", { path: "src/tracked.ts" });
    expect(outcome.kind).toBe("ok");
  });

  test("without a grant the runtime refuses before reaching the tool", async () => {
    const policy = compileToolPolicy([{ tool: "Read", patterns: ["*"] }], root);
    const runtime = createCodingToolRuntime({ policy });
    const outcome = await runtime.callTool("Delete", { path: "src/tracked.ts" });
    expect(outcome.kind).toBe("denied");
  });

  test("the policy refuses a path outside the permitted root, and flags it as a breach", async () => {
    const policy = compileToolPolicy([{ tool: "Delete", patterns: ["*"] }], root);
    const runtime = createCodingToolRuntime({ policy });
    const outcome = await runtime.callTool("Delete", { path: "../escape.ts" });
    expect(outcome.kind).toBe("denied");
    if (outcome.kind !== "denied") throw new Error("expected a denial");
    expect(outcome.breach).toBe(true);
    expect(outcome.reason).toContain("outside the permitted root");
  });

  // nax#1972 / nax#1943: Delete carries no .git-specific logic of its own --
  // the exclusion lives once, in resolveWithin (src/tools/policy.ts), for
  // every path-bearing tool. This pins that a real Delete call still cannot
  // reach anything under .git/, through the actual policy + runtime a call
  // takes in production, rather than re-asserting it inside delete.ts.
  test("the policy refuses a path under .git/ before Delete ever runs", async () => {
    const policy = compileToolPolicy([{ tool: "Delete", patterns: ["*"] }], root);
    const runtime = createCodingToolRuntime({ policy });
    const outcome = await runtime.callTool("Delete", { path: ".git/index" });
    expect(outcome.kind).toBe("denied");
  });

  test("denyPaths passed to createCodingToolRuntime reaches Delete ahead of the tracked/ignored logic", async () => {
    const policy = compileToolPolicy([{ tool: "Delete", patterns: ["*"] }], root);
    const runtime = createCodingToolRuntime({ policy, denyPaths: ["src/tracked.ts"] });
    const outcome = await runtime.callTool("Delete", { path: "src/tracked.ts" });
    expect(outcome.kind).toBe("error");
    if (outcome.kind !== "error") throw new Error("expected a tool-level refusal");
    expect(outcome.content).toContain("denyPaths");
  });

  test("Delete then GitCommit records the removal in a commit", async () => {
    const policy = compileToolPolicy(
      [
        { tool: "Delete", patterns: ["*"] },
        { tool: "GitCommit", patterns: ["*"] },
      ],
      root,
    );
    const runtime = createCodingToolRuntime({ policy });

    const deleted = await runtime.callTool("Delete", { path: "src/tracked.ts" });
    expect(deleted.kind).toBe("ok");

    // The deleted path is passed straight to GitCommit. This is the property
    // the spec verified by hand: `git add -- <deleted path>` stages a deletion,
    // and realOrRaw resolves a path that no longer exists, so the policy still
    // admits it. If either stopped holding, this test is where it shows.
    const committed = await runtime.callTool("GitCommit", {
      message: "chore: remove tracked.ts",
      paths: ["src/tracked.ts"],
    });
    expect(committed.kind).toBe("ok");

    const show = await gitWithTimeout(["show", "--stat", "--oneline", "HEAD"], root, 30_000);
    expect(show.exitCode).toBe(0);
    expect(show.stdout).toContain("src/tracked.ts");
    expect(show.stdout).toContain("1 deletion");
  });
});
