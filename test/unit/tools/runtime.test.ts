import { beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileToolPolicy, createCodingToolRuntime } from "@/tools";

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "nax-runtime-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "const a = 1;\n");
});

function runtimeWith(grants: { tool: string; patterns: string[] }[]) {
  return createCodingToolRuntime({ policy: compileToolPolicy(grants, root) });
}

describe("createCodingToolRuntime", () => {
  test("executes a permitted call", async () => {
    const rt = runtimeWith([{ tool: "Read", patterns: ["*"] }]);
    const out = await rt.callTool("Read", { path: "src/a.ts" });
    expect(out.kind).toBe("ok");
    if (out.kind === "ok") expect(out.content).toContain("const a = 1;");
  });

  // The distinction ADR-029 section 5 exists to protect: a refusal is not a crash.
  test("a policy refusal is 'denied', not 'error'", async () => {
    const rt = runtimeWith([{ tool: "Read", patterns: ["docs/**"] }]);
    const out = await rt.callTool("Read", { path: "src/a.ts" });
    expect(out.kind).toBe("denied");
  });

  test("an ungranted tool is denied", async () => {
    const rt = runtimeWith([{ tool: "Read", patterns: ["*"] }]);
    expect((await rt.callTool("Write", { path: "src/a.ts", content: "x" })).kind).toBe("denied");
  });

  test("a containment breach is denied and flagged", async () => {
    const rt = runtimeWith([{ tool: "Read", patterns: ["*"] }]);
    const out = await rt.callTool("Read", { path: "../../etc/hosts" });
    expect(out.kind).toBe("denied");
    if (out.kind === "denied") expect(out.breach).toBe(true);
  });

  test("a failing tool is 'error', distinct from 'denied'", async () => {
    const rt = runtimeWith([{ tool: "Read", patterns: ["*"] }]);
    const out = await rt.callTool("Read", { path: "src/missing.ts" });
    expect(out.kind).toBe("error");
  });

  test("an unknown tool name is denied", async () => {
    const rt = runtimeWith([{ tool: "Nope", patterns: ["*"] }]);
    expect((await rt.callTool("Nope", {})).kind).toBe("denied");
  });

  test("a thrown tool becomes 'error', never an escaped exception", async () => {
    const rt = runtimeWith([{ tool: "Git", patterns: ["*"] }]);
    // A permitted verb that fails at execution (no git repo here): the verb
    // gate denies unknown subcommands before the tool runs, so failure must
    // come from the tool itself, surfacing as 'error', not 'denied'.
    const out = await rt.callTool("Git", { subcommand: "status" });
    expect(out.kind).toBe("error");
  });
});

describe("advertised", () => {
  test("intersects the op's declaration with the policy's grants", () => {
    const rt = runtimeWith([
      { tool: "Read", patterns: ["*"] },
      { tool: "Glob", patterns: ["*"] },
    ]);
    expect(rt.advertised(["Read", "Write"]).map((t) => t.name)).toEqual(["Read"]);
  });

  test("a tool granted but not declared is not advertised", () => {
    const rt = runtimeWith([
      { tool: "Read", patterns: ["*"] },
      { tool: "Git", patterns: ["*"] },
    ]);
    expect(rt.advertised(["Read"]).map((t) => t.name)).toEqual(["Read"]);
  });

  test("declaring nothing advertises nothing", () => {
    const rt = runtimeWith([{ tool: "Read", patterns: ["*"] }]);
    expect(rt.advertised([])).toEqual([]);
  });
});
