import { test, expect, beforeEach, afterEach } from "bun:test";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { TestCoverageProvider, _testCoverageProviderDeps } from "../../../src/context/engine/providers/test-coverage";
import { FLOOR_KINDS, packChunks } from "../../../src/context/engine/packing";
import { getStageContextConfig } from "../../../src/context/engine/stage-config";
import { ContextOrchestrator } from "../../../src/context/engine/orchestrator";
import { generateTestCoverageSummary } from "../../../src/context/test-scanner";
import { withTempDir } from "../../../test/helpers/temp";
import type { NaxConfig } from "../../../src/config/types";
import type { UserStory } from "../../../src/prd/types";
import type { IContextProvider } from "../../../src/context/engine/types";

const PKG = join(import.meta.dir, "../../..");
const PARITY = join(PKG, "test/integration/context/test-coverage-parity.test.ts");

const STORY: UserStory = {
  id: "s1", title: "T", description: "", acceptanceCriteria: [], status: "pending",
} as unknown as UserStory;

function makeCfg(tc: Record<string, unknown> = {}): NaxConfig {
  return { context: { testCoverage: { enabled: true, maxTokens: 500, detail: "names-and-counts", scopeToStory: true, ...tc } } } as unknown as NaxConfig;
}

function makeReq(o: Record<string, unknown> = {}): any {
  return { storyId: "s1", repoRoot: "/r", packageDir: "/r", stage: "execution", role: "implementer", budgetTokens: 8_000, ...o };
}

function stubProvider(id: string, kind: string): IContextProvider {
  return { id, kind: kind as any, fetch: async () => ({ chunks: [], pullTools: [] }) };
}

function makeOrch(cfg: NaxConfig): ContextOrchestrator {
  return new ContextOrchestrator([
    stubProvider("static-rules", "static"), stubProvider("feature-context", "feature"),
    stubProvider("session-scratch", "session"), stubProvider("git-history", "history"),
    stubProvider("code-neighbor", "neighbor"), new TestCoverageProvider(STORY, cfg),
  ]);
}

function sha8(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 8);
}

let orig: typeof _testCoverageProviderDeps;
beforeEach(() => { orig = { ..._testCoverageProviderDeps }; });
afterEach(() => { Object.assign(_testCoverageProviderDeps, orig); });

function sp(g = ["**/*.test.ts"]): void {
  _testCoverageProviderDeps.resolveTestFilePatterns = async () =>
    ({ globs: g, patterns: g, testDirs: ["test"], pathspec: [], regex: [], resolution: "fallback" } as any);
}
function ss(summary: string, tokens = 0): void {
  _testCoverageProviderDeps.generateTestCoverageSummary = async () =>
    ({ summary, tokens, files: [], totalTests: 0 } as any);
}
function sg(): void { _testCoverageProviderDeps.getContextFiles = () => []; }

test("AC-1: ChunkKind includes 'test-coverage' — provider.kind and FLOOR_KINDS confirm", () => {
  const p = new TestCoverageProvider(STORY, {} as NaxConfig);
  expect(p.kind).toBe("test-coverage");
  expect((FLOOR_KINDS as string[]).includes("test-coverage")).toBe(true);
});

test("AC-2: floor predicate true for static/feature/test-coverage, false for code", () => {
  expect(FLOOR_KINDS).toContain("test-coverage");
  expect(FLOOR_KINDS).toContain("static");
  expect(FLOOR_KINDS).toContain("feature");
  expect((FLOOR_KINDS as string[]).includes("code")).toBe(false);
});

test("AC-3: typecheck passes; test-coverage chunk processed without exhaustiveness error", () => {
  const r = Bun.spawnSync(["bun", "run", "typecheck"], { cwd: PKG, stderr: "ignore", stdout: "ignore" });
  expect(r.exitCode).toBe(0);
  const ch = { id: "test-coverage:ab123456", kind: "test-coverage" as const, scope: "story" as const, role: ["implementer" as const], content: "x", tokens: 1, rawScore: 0.5 };
  const packed = packChunks([{ ...ch, score: 0.5, roleFiltered: false, belowMinScore: false }], 10_000);
  expect(packed.packed).toHaveLength(1);
}, 90_000);

test("AC-4: test-coverage and feature chunks are distinct in packed manifest", async () => {
  sp(); ss("tc content", 10); sg();
  const r = await new TestCoverageProvider(STORY, makeCfg()).fetch(makeReq());
  expect(r.chunks[0].kind).toBe("test-coverage");
  const packed = packChunks([
    { ...r.chunks[0], score: 0.85, roleFiltered: false, belowMinScore: false } as any,
    { id: "feature:00000000", kind: "feature" as const, scope: "feature" as const, role: ["implementer" as const], content: "fc", tokens: 5, rawScore: 0.9, score: 0.9, roleFiltered: false, belowMinScore: false },
  ], 100_000);
  const ids = packed.packed.map((c) => c.id);
  expect(ids.some((id) => id.startsWith("test-coverage:"))).toBe(true);
  expect(ids.some((id) => id.startsWith("feature:"))).toBe(true);
  expect(packed.packed).toHaveLength(2);
});

test("AC-5: bun run typecheck exits with code 0, zero diagnostics", () => {
  const r = Bun.spawnSync(["bun", "run", "typecheck"], { cwd: PKG, stderr: "ignore", stdout: "ignore" });
  expect(r.exitCode).toBe(0);
}, 90_000);

test("AC-6: test-coverage chunk included even when minScore threshold exceeds its rawScore", async () => {
  sp(); ss("floor content", 10); sg();
  const orch = makeOrch(makeCfg());
  const bundle = await orch.assemble({ ...makeReq(), minScore: 0.99 });
  expect(bundle.chunks.some((c) => c.kind === "test-coverage")).toBe(true);
});

test("AC-7: provider id='test-coverage', kind='test-coverage', has fetch(); IContextProvider satisfied", () => {
  const p = new TestCoverageProvider(STORY, {} as NaxConfig);
  expect(p.id).toBe("test-coverage");
  expect(p.kind).toBe("test-coverage");
  expect(typeof p.fetch).toBe("function");
  expect(p.id).toBe("test-coverage");
  expect(p.kind).toBe("test-coverage");
});

test("AC-8: fetch uses story and config values in downstream dep calls", async () => {
  let capturedWorkdir: string | undefined;
  let capturedMaxTokens: number | undefined;
  let capturedStory: UserStory | undefined;
  sp();
  _testCoverageProviderDeps.generateTestCoverageSummary = async (o: any) => {
    capturedWorkdir = o.workdir; capturedMaxTokens = o.maxTokens;
    return { summary: "", tokens: 0, files: [], totalTests: 0 } as any;
  };
  _testCoverageProviderDeps.getContextFiles = (s) => { capturedStory = s; return []; };
  await new TestCoverageProvider(STORY, makeCfg({ maxTokens: 777 })).fetch(makeReq({ packageDir: "/custom/pkg" }));
  expect(capturedWorkdir).toBe("/custom/pkg");
  expect(capturedMaxTokens).toBe(777);
  expect(capturedStory).toBe(STORY);
});

test("AC-9: enabled=false → empty chunks, scanner NOT called", async () => {
  let called = false;
  _testCoverageProviderDeps.generateTestCoverageSummary = async () => { called = true; return { summary: "", tokens: 0, files: [], totalTests: 0 } as any; };
  const r = await new TestCoverageProvider(STORY, makeCfg({ enabled: false })).fetch(makeReq());
  expect(r.chunks).toHaveLength(0);
  expect(r.pullTools).toEqual([]);
  expect(called).toBe(false);
});

test("AC-10: packageDir undefined/'' → empty chunks, scanner NOT called", async () => {
  let called = false;
  sp(); sg();
  _testCoverageProviderDeps.generateTestCoverageSummary = async () => { called = true; return { summary: "", tokens: 0, files: [], totalTests: 0 } as any; };
  const p = new TestCoverageProvider(STORY, makeCfg());
  const r1 = await p.fetch(makeReq({ packageDir: undefined }));
  const r2 = await p.fetch(makeReq({ packageDir: "" }));
  expect(r1.chunks).toHaveLength(0);
  expect(r2.chunks).toHaveLength(0);
  expect(called).toBe(false);
});

test("AC-11: scanner workdir equals request.packageDir, not repoRoot, not process.cwd()", async () => {
  let w: string | undefined;
  sp();
  _testCoverageProviderDeps.generateTestCoverageSummary = async (o: any) => { w = o.workdir; return { summary: "", tokens: 0, files: [], totalTests: 0 } as any; };
  sg();
  await new TestCoverageProvider(STORY, makeCfg()).fetch(makeReq({ packageDir: "/some/pkg", repoRoot: "/different" }));
  expect(w).toBe("/some/pkg");
  expect(w).not.toBe("/different");
  expect(w).not.toBe(process.cwd());
});

test("AC-12: config fields forwarded; defaults maxTokens=500, detail='names-and-counts', scopeToStory=true", async () => {
  let c1: any; let c2: any;
  sp();
  _testCoverageProviderDeps.generateTestCoverageSummary = async (o: any) => { c1 = o; return { summary: "", tokens: 0, files: [], totalTests: 0 } as any; };
  _testCoverageProviderDeps.getContextFiles = () => ["src/a.ts"];
  await new TestCoverageProvider(STORY, makeCfg({ testDir: "td", maxTokens: 300, detail: "names-only", scopeToStory: false })).fetch(makeReq());
  expect(c1.testDir).toBe("td"); expect(c1.maxTokens).toBe(300); expect(c1.detail).toBe("names-only"); expect(c1.scopeToStory).toBe(false);
  _testCoverageProviderDeps.generateTestCoverageSummary = async (o: any) => { c2 = o; return { summary: "", tokens: 0, files: [], totalTests: 0 } as any; };
  await new TestCoverageProvider(STORY, { context: { testCoverage: { enabled: true } } } as unknown as NaxConfig).fetch(makeReq());
  expect(c2.maxTokens).toBe(500); expect(c2.detail).toBe("names-and-counts"); expect(c2.scopeToStory).toBe(true);
});

test("AC-13: resolveTestFilePatterns receives (config, repoRoot, packageDir); globs forwarded to scanner", async () => {
  let ra: any; let scanGlobs: any;
  const gls = ["pkgs/a/**/*.test.ts"];
  _testCoverageProviderDeps.resolveTestFilePatterns = async (config, workdir, pkgDir) => {
    ra = { config, workdir, pkgDir };
    return { globs: gls, patterns: gls, testDirs: [], pathspec: [], regex: [], resolution: "fallback" } as any;
  };
  _testCoverageProviderDeps.generateTestCoverageSummary = async (o: any) => { scanGlobs = o.resolvedTestGlobs; return { summary: "", tokens: 0, files: [], totalTests: 0 } as any; };
  sg();
  const cfg = makeCfg();
  await new TestCoverageProvider(STORY, cfg).fetch(makeReq({ repoRoot: "/rr", packageDir: "/rr/pkg" }));
  expect(ra.config).toBe(cfg); expect(ra.workdir).toBe("/rr"); expect(ra.pkgDir).toBe("/rr/pkg");
  expect(scanGlobs).toEqual(gls);
});

test("AC-14: empty summary from scanner → empty chunks, empty pullTools", async () => {
  sp(); ss("", 0); sg();
  const r = await new TestCoverageProvider(STORY, makeCfg()).fetch(makeReq());
  expect(r.chunks).toHaveLength(0);
  expect(r.pullTools).toHaveLength(0);
});

test("AC-15: non-empty summary → one chunk with correct content/tokens/kind/scope/role/rawScore", async () => {
  sp(); ss("some coverage text", 42); sg();
  const r = await new TestCoverageProvider(STORY, makeCfg()).fetch(makeReq());
  expect(r.chunks).toHaveLength(1);
  const c = r.chunks[0];
  expect(c.content).toBe("some coverage text");
  expect(c.tokens).toBe(42);
  expect(c.kind).toBe("test-coverage");
  expect(c.scope).toBe("story");
  expect(c.role).toEqual(["implementer", "tdd"]);
  expect(c.rawScore).toBe(0.85);
});

test("AC-16: chunk id = 'test-coverage:<sha256-first-8-hex-of-content>'", async () => {
  const content = "hello";
  sp(); ss(content, 1); sg();
  const r = await new TestCoverageProvider(STORY, makeCfg()).fetch(makeReq());
  expect(r.chunks[0].id).toMatch(/^test-coverage:[0-9a-f]{8}$/);
  expect(r.chunks[0].id).toBe(`test-coverage:${sha8(content)}`);
});

test("AC-17: scanner throws → fetch resolves empty; logger.warn called once with storyId/packageDir/error", async () => {
  sp(); sg();
  _testCoverageProviderDeps.generateTestCoverageSummary = async () => { throw new Error("scan failed"); };
  const warns: any[] = [];
  _testCoverageProviderDeps.getLogger = () => ({
    warn: (c: string, _m: string, d?: any) => warns.push({ c, d }),
    info: () => {}, debug: () => {}, error: () => {},
  } as any);
  const r = await new TestCoverageProvider(STORY, makeCfg()).fetch(makeReq({ packageDir: "/p" }));
  expect(r.chunks).toHaveLength(0);
  expect(r.pullTools).toEqual([]);
  expect(warns).toHaveLength(1);
  expect(warns[0].c).toBe("test-coverage");
  expect(warns[0].d.storyId).toBe("s1");
  expect(warns[0].d.packageDir).toBe("/p");
  expect(warns[0].d.error).toBeDefined();
});

test("AC-18: logger.warn data has storyId as first key, packageDir as second", async () => {
  sp(); sg();
  _testCoverageProviderDeps.generateTestCoverageSummary = async () => { throw new Error("err"); };
  const warnData: Record<string, unknown>[] = [];
  _testCoverageProviderDeps.getLogger = () => ({
    warn: (_c: string, _m: string, d?: Record<string, unknown>) => { if (d) warnData.push(d); },
    info: () => {}, debug: () => {}, error: () => {},
  } as any);
  await new TestCoverageProvider(STORY, makeCfg()).fetch(makeReq({ packageDir: "/pp" }));
  expect(warnData.length).toBeGreaterThan(0);
  const keys = Object.keys(warnData[0]);
  expect(keys[0]).toBe("storyId");
  expect(keys[1]).toBe("packageDir");
});

test("AC-19: _testCoverageProviderDeps exported, mutable; replacement functions are invoked", async () => {
  expect(_testCoverageProviderDeps).toBeDefined();
  expect(typeof _testCoverageProviderDeps.generateTestCoverageSummary).toBe("function");
  expect(typeof _testCoverageProviderDeps.resolveTestFilePatterns).toBe("function");
  let invoked = false;
  sp();
  _testCoverageProviderDeps.generateTestCoverageSummary = async () => { invoked = true; return { summary: "", tokens: 0, files: [], totalTests: 0 } as any; };
  sg();
  await new TestCoverageProvider(STORY, makeCfg()).fetch(makeReq());
  expect(invoked).toBe(true);
});

test("AC-20: orchestrator-factory pushes TestCoverageProvider before additionalProviders spread", async () => {
  const src = await Bun.file(join(PKG, "src/context/engine/orchestrator-factory.ts")).text();
  expect(src).toContain("new TestCoverageProvider(story, config)");
  expect(src.indexOf("new TestCoverageProvider(story, config)")).toBeLessThan(src.indexOf("...additionalProviders"));
});

test("AC-21: no conditional guard around TestCoverageProvider construction in orchestrator-factory", async () => {
  const src = await Bun.file(join(PKG, "src/context/engine/orchestrator-factory.ts")).text();
  const lines = src.split("\n");
  const idx = lines.findIndex((l) => l.includes("new TestCoverageProvider(story, config)"));
  expect(idx).toBeGreaterThanOrEqual(0);
  const ctx = lines.slice(Math.max(0, idx - 5), idx + 2).join("\n");
  expect(ctx).not.toMatch(/testCoverage\.enabled/);
  expect(ctx).not.toMatch(/if\s*\(/);
});

test("AC-22: implementer stages (execution, tdd-implementer) include 'test-coverage'", () => {
  expect(getStageContextConfig("execution").providerIds).toContain("test-coverage");
  expect(getStageContextConfig("tdd-implementer").providerIds).toContain("test-coverage");
});

test("AC-23: tdd stages (tdd-implementer, tdd-simple) include 'test-coverage'", () => {
  expect(getStageContextConfig("tdd-implementer").providerIds).toContain("test-coverage");
  expect(getStageContextConfig("tdd-simple").providerIds).toContain("test-coverage");
});

test("AC-24: review, rectify, decompose stages do NOT include 'test-coverage'", () => {
  expect(getStageContextConfig("review").providerIds).not.toContain("test-coverage");
  expect(getStageContextConfig("rectify").providerIds).not.toContain("test-coverage");
  expect(getStageContextConfig("decompose").providerIds).not.toContain("test-coverage");
});

test("AC-25: assemble() with stage referencing test-coverage does not throw unknown provider error", async () => {
  sp(); ss("", 0); sg();
  const orch = makeOrch(makeCfg({ enabled: false }));
  const bundle = await orch.assemble(makeReq());
  expect(bundle).toBeDefined();
  expect((bundle.manifest.providerResults ?? []).some((r: any) => r.providerId === "test-coverage")).toBe(true);
});

test("AC-26: assemble() with enabled=true + fixture test file → providerResults test-coverage:ok", async () => {
  await withTempDir(async (dir) => {
    mkdirSync(join(dir, "test"), { recursive: true });
    writeFileSync(join(dir, "test", "foo.test.ts"), 'describe("f", () => { test("x", () => {}); });');
    _testCoverageProviderDeps.generateTestCoverageSummary = generateTestCoverageSummary as any;
    _testCoverageProviderDeps.resolveTestFilePatterns = async () =>
      ({ globs: ["**/*.test.ts"], patterns: ["**/*.test.ts"], testDirs: ["test"], pathspec: [], regex: [], resolution: "fallback" } as any);
    _testCoverageProviderDeps.getContextFiles = () => [];
    const orch = makeOrch(makeCfg({ scopeToStory: false }));
    const bundle = await orch.assemble({ ...makeReq(), repoRoot: dir, packageDir: dir });
    const tc = (bundle.manifest.providerResults ?? []).find((r: any) => r.providerId === "test-coverage");
    expect(tc?.status).toBe("ok");
  });
}, 15_000);

test("AC-27: assemble() with enabled=false → providerResults test-coverage:empty, chunkCount=0", async () => {
  sp(); ss("", 0); sg();
  const orch = makeOrch(makeCfg({ enabled: false }));
  const bundle = await orch.assemble(makeReq());
  const tc = (bundle.manifest.providerResults ?? []).find((r: any) => r.providerId === "test-coverage");
  expect(tc).toBeDefined();
  expect(tc?.status).toBe("empty");
  expect(tc?.chunkCount).toBe(0);
});

test("AC-28: orchestrator-factory and stage-config have only additive changes; all original providers present", async () => {
  const factory = await Bun.file(join(PKG, "src/context/engine/orchestrator-factory.ts")).text();
  const stageCfg = await Bun.file(join(PKG, "src/context/engine/stage-config.ts")).text();
  for (const cls of ["StaticRulesProvider", "FeatureContextProviderV2", "SessionScratchProvider", "GitHistoryProvider", "CodeNeighborProvider", "TestCoverageProvider"]) {
    expect(factory).toContain(cls);
  }
  for (const id of ["static-rules", "feature-context", "session-scratch", "git-history", "code-neighbor", "test-coverage"]) {
    expect(stageCfg).toContain(`"${id}"`);
  }
});

test("AC-29: parity test file exists with at least 4 test() calls", async () => {
  expect(await Bun.file(PARITY).exists()).toBe(true);
  const c = await Bun.file(PARITY).text();
  expect((c.match(/\btest\(/g) ?? []).length).toBeGreaterThanOrEqual(4);
});

test("AC-30: parity file has no /tmp/ literals, no rm -rf, imports from test/helpers/temp", async () => {
  const c = await Bun.file(PARITY).text();
  expect(c).not.toContain("/tmp/");
  expect(c).not.toContain("rm -rf");
  expect(c).toContain("helpers/temp");
});

test("AC-31: parity file contains byte-equal content assertions comparing v2 chunk.content to v1 summary", async () => {
  const c = await Bun.file(PARITY).text();
  expect(c).toContain("v1Result.summary");
  expect(c).toMatch(/chunks\[0\]\.content/);
  expect(c).toContain(".toBe(v1Result.summary)");
});

test("AC-32: parity file has scopeToStory=true test case with subset filtering assertions", async () => {
  const c = await Bun.file(PARITY).text();
  expect(c).toContain("scopeToStory");
  expect(c).toContain("contextFiles");
  expect(c).toContain(".toContain(");
  expect(c).toContain(".not.toContain(");
});

test("AC-33: parity file has empty test directory case asserting v1 returns empty and v2 returns empty chunks", async () => {
  const c = await Bun.file(PARITY).text();
  expect(c).toMatch(/v2Result\.chunks.*toHaveLength\(0\)/s);
  expect(c).toMatch(/v1Result\.summary.*toBe\(""\)/s);
});

test("AC-34: parity test suite passes (exit code 0, no timeout)", () => {
  const r = Bun.spawnSync(
    ["timeout", "60", "bun", "test", "test/integration/context/test-coverage-parity.test.ts", "--timeout=30000"],
    { cwd: PKG },
  );
  expect(r.exitCode).toBe(0);
}, 90_000);

test("AC-35: parity file under 400 lines, no mock.module, uses _testCoverageProviderDeps", async () => {
  const c = await Bun.file(PARITY).text();
  expect(c.split("\n").length).toBeLessThan(400);
  expect(c).not.toContain("mock.module");
  expect(c).toContain("_testCoverageProviderDeps");
});