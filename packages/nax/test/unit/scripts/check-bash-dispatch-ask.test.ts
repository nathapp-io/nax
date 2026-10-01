/**
 * Tests for the Bash-dispatch ask-wiring gate (#2202).
 *
 * The gate fails when a CallContext construction in src/ names neither
 * askResolver nor commandShadow and is not allowlisted as Bash-free. Each
 * case below pins one shape the scanner must get right, and the last block
 * pins the real tree: the #2201 sites are wired, and the gate reads clean.
 */

import { describe, expect, test } from "bun:test";
import {
  ALLOWED_BARE_SITES,
  bashCarryingNames,
  type ContextSite,
  evaluate,
  findContextSites,
  scanTree,
} from "@scripts/check-bash-dispatch-ask";
import * as operations from "@/operations";

const FILE = "src/example/site.ts";

function sitesOf(lines: string[]): ContextSite[] {
  return findContextSites(FILE, lines.join("\n"));
}

describe("findContextSites — classification", () => {
  test("a bare CallContext literal is reported with both missing fields", () => {
    const sites = sitesOf([
      "export async function dispatchFix(ctx: Ctx) {",
      "  const callCtx: CallContext = {",
      "    runtime: ctx.runtime,",
      "    packageView,",
      "    packageDir: ctx.workdir,",
      '    agentName: "claude",',
      "  };",
      "  return callOp(callCtx, finishFixOp, input);",
      "}",
    ]);
    expect(sites).toEqual([
      { file: FILE, line: 2, fn: "dispatchFix", kind: "bare", missing: ["askResolver", "commandShadow"] },
    ]);
  });

  test("members or conditional spreads naming both fields make it wired", () => {
    const sites = sitesOf([
      "function build() {",
      "  return {",
      "    runtime, packageView, packageDir, agentName,",
      "    askResolver: wiring.askResolver,",
      "    ...(wiring.commandShadow ? { commandShadow: wiring.commandShadow } : {}),",
      "  };",
      "}",
    ]);
    expect(sites.map((s) => s.kind)).toEqual(["wired"]);
  });

  test("only one of the two fields is still bare, naming the missing one", () => {
    const sites = sitesOf(["const x = { runtime, packageView, agentName, askResolver };"]);
    expect(sites[0]).toMatchObject({ kind: "bare", missing: ["commandShadow"] });
  });

  test("an unannotated literal passed straight to callOp is found", () => {
    const sites = sitesOf([
      "const run = async () =>",
      "  callOp({ runtime: rt, packageView: rt.packages.resolve(), packageDir: dir, agentName }, op, input);",
    ]);
    expect(sites).toHaveLength(1);
    expect(sites[0]?.fn).toBe("run");
  });

  test("a leading spread of an unverified source does not supply the fields", () => {
    const sites = sitesOf(["const next = { ...baseOpts, runtime, packageView, agentName, config };"]);
    expect(sites[0]).toMatchObject({ kind: "bare", missing: ["askResolver", "commandShadow"] });
  });

  test("a leading spread with both fields named explicitly is wired", () => {
    const sites = sitesOf([
      "const next = {",
      "  ...callCtx, runtime, packageView, agentName: other,",
      "  askResolver: callCtx.askResolver, commandShadow: callCtx.commandShadow,",
      "};",
    ]);
    expect(sites.map((s) => s.kind)).toEqual(["wired"]);
  });

  test("the field names in comments or strings do not count as wiring", () => {
    const sites = sitesOf([
      "const c = {",
      "  runtime, packageView, agentName,",
      "  // askResolver and commandShadow are attached later",
      '  note: "askResolver commandShadow",',
      "};",
    ]);
    expect(sites[0]).toMatchObject({ kind: "bare", missing: ["askResolver", "commandShadow"] });
  });

  test("a PipelineContext-like literal without agentName is not a CallContext", () => {
    expect(sitesOf(["const p = { runtime, packageView, config };"])).toEqual([]);
  });
});

describe("findContextSites — enclosing function", () => {
  test("a multi-line signature closing with `): T {` resolves to the declaration", () => {
    const sites = sitesOf([
      "export async function resolveRouting(",
      "  story: UserStory,",
      "): Promise<RoutingDecision> {",
      "  if (x) {",
      "    const ctx = { runtime, packageView, agentName };",
      "  }",
      "}",
    ]);
    expect(sites[0]?.fn).toBe("resolveRouting");
  });

  test("an object-property arrow and a top-level literal", () => {
    const sites = sitesOf([
      "export const _deps = {",
      "  callOp: async (input: unknown) => {",
      "    return run({ runtime, packageView, agentName });",
      "  },",
      "};",
      "const top = { runtime, packageView, agentName };",
    ]);
    expect(sites.map((s) => s.fn)).toEqual(["callOp", "<module>"]);
  });
});

describe("bashCarryingNames", () => {
  test("Bash ops under every alias, and functions whose source names one", () => {
    const bashOp = { kind: "run", name: "fix", tools: ["Read", "Bash"] };
    const names = bashCarryingNames({
      fixOp: bashOp,
      fixAliasOp: bashOp,
      readOnlyOp: { kind: "run", name: "ro", tools: ["Read"] },
      defaultToolsOp: { kind: "run", name: "dflt" },
      completeOp: { kind: "complete", name: "c" },
      makeFixStrategy: () => ({ fixOp: "fixOp" }),
      unrelated: () => 1,
    });
    expect([...names].sort()).toEqual(["fixAliasOp", "fixOp", "makeFixStrategy"]);
  });

  test("the real barrel: the #2201 ops and the regression strategy factory are all Bash-carrying", () => {
    const names = bashCarryingNames(operations);
    for (const name of [
      "finishFixOp",
      "acceptanceFixSourceOp",
      "acceptanceFixTestOp",
      "fullSuiteRectifyOp",
      "makeFullSuiteRectifyStrategy",
      "implementerOp",
      "testWriterOp",
    ]) {
      expect(names.has(name)).toBe(true);
    }
    expect(names.has("classifyRouteOp")).toBe(false);
    expect(names.has("acceptanceDiagnoseOp")).toBe(false);
  });
});

describe("evaluate", () => {
  const bare = (fn: string): ContextSite => ({ file: FILE, line: 1, fn, kind: "bare", missing: ["askResolver"] });
  const allow = (fn: string) => ({ file: FILE, fn, reason: "r" });

  test("an unallowlisted bare site is a violation; a wired one is not", () => {
    const wired: ContextSite = { ...bare("a"), kind: "wired", missing: [] };
    const findings = evaluate([bare("c"), wired], [], new Map(), new Set());
    expect(findings.violations.map((v) => v.fn)).toEqual(["c"]);
  });

  test("an allowlist entry covering no bare site is stale", () => {
    const findings = evaluate([bare("c")], [allow("c"), allow("gone")], new Map(), new Set());
    expect(findings.violations).toEqual([]);
    expect(findings.stale.map((s) => s.fn)).toEqual(["gone"]);
  });

  test("an allowlisted file referencing a Bash-carrying name leaks, comments aside", () => {
    const sources = new Map([[FILE, "// finishFixOp is not used here\nawait callOp(ctx, finishFixOp, input);"]]);
    const findings = evaluate([bare("c")], [allow("c")], sources, new Set(["finishFixOp", "otherOp"]));
    expect(findings.leaks).toEqual([{ file: FILE, names: ["finishFixOp"] }]);
    const commentOnly = new Map([[FILE, "// finishFixOp is not used here"]]);
    expect(evaluate([bare("c")], [allow("c")], commentOnly, new Set(["finishFixOp"])).leaks).toEqual([]);
  });
});

describe("the real tree", () => {
  test("every #2201 Bash-dispatching site is wired and the gate reads clean", async () => {
    const { sites, findings } = await scanTree();
    const wired = new Set(sites.filter((s) => s.kind === "wired").map((s) => s.file));
    for (const file of [
      "src/pipeline/stages/execution.ts",
      "src/finish/phase.ts",
      "src/execution/lifecycle/acceptance-fix-scope.ts",
      "src/execution/lifecycle/run-regression.ts",
    ]) {
      expect(wired.has(file)).toBe(true);
    }
    expect(findings).toEqual({ violations: [], stale: [], leaks: [] });
    expect(ALLOWED_BARE_SITES.every((entry) => entry.reason.length > 0)).toBe(true);
  });
});
