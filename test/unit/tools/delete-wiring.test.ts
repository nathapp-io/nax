import { beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeNaxConfig } from "@test/helpers";
import { resolvePermissions } from "@/config/permissions";
import { compileToolPolicy } from "@/tools/policy";
import { createCodingToolRuntime } from "@/tools/runtime";
import { gitWithTimeout } from "@/utils/git";

let root: string;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "nax-delete-wiring-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "tracked.ts"), "export const a = 1;\n");
  await gitWithTimeout(["init", "-q", "."], root, 30_000);
  await gitWithTimeout(["config", "user.email", "t@example.com"], root, 30_000);
  await gitWithTimeout(["config", "user.name", "t"], root, 30_000);
  await gitWithTimeout(["add", "-A"], root, 30_000);
  await gitWithTimeout(["commit", "-q", "-m", "init"], root, 30_000);
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
