import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { _cycleDeps } from "../../../../src/findings/cycle";
import { _autofixDeps } from "../../../../src/pipeline/stages/autofix";
import { _autofixCycleGuardDeps, runAgentRectificationV2 } from "../../../../src/pipeline/stages/autofix-cycle";
import {
	_guardDeps,
	assertionSiteDiffCheck,
	revertDiff,
	runIsolationGuard,
} from "../../../../src/pipeline/stages/autofix-guards";
import { makeMockAgentManager, makeNaxConfig, makeStory, withDepsRestore } from "../../../helpers";

function makeGitDiffSpawn(output: string, exitCode = 0): typeof _guardDeps.spawn {
	return mock((_cmd: string[], _opts?: unknown) => ({
		exited: Promise.resolve(exitCode),
		stdout: new Response(output).body as ReadableStream<Uint8Array>,
		stderr: new Response("").body as ReadableStream<Uint8Array>,
		kill: () => {},
	})) as unknown as typeof _guardDeps.spawn;
}

// ─── assertionSiteDiffCheck — spec-correct behavior ──────────────────────────

describe("assertionSiteDiffCheck — spec-correct behavior (AC2, AC3)", () => {
	withDepsRestore(_guardDeps);

	test("AC2: detects expect( in an added line and returns violated:true with file, line, content", async () => {
		const diff = "@@ -0,0 +1 @@\n+  expect(result).toBe(42)\n";
		_guardDeps.spawn = makeGitDiffSpawn(diff);
		const result = await assertionSiteDiffCheck("/workdir", "abc123", ["test/foo.test.ts"]);
		expect(result.violated).toBe(true);
		if (result.violated) {
			expect(result.file).toBe("test/foo.test.ts");
			expect(result.line).toBe(1);
			expect(result.content).toContain("expect(result)");
		}
	});

	test("AC2: detects .toBe( in a second added line and line number increments correctly", async () => {
		const diff = "@@ -0,0 +1,2 @@\n+const x = 1;\n+result.toBe(42)\n";
		_guardDeps.spawn = makeGitDiffSpawn(diff);
		const result = await assertionSiteDiffCheck("/workdir", "abc123", ["test/foo.test.ts"]);
		expect(result.violated).toBe(true);
		if (result.violated) {
			expect(result.content).toContain(".toBe(");
			expect(result.line).toBe(2);
		}
	});

	test("AC2: detects .toEqual( in an added line", async () => {
		const diff = "@@ -0,0 +1 @@\n+  result.toEqual({ ok: true })\n";
		_guardDeps.spawn = makeGitDiffSpawn(diff);
		const result = await assertionSiteDiffCheck("/workdir", "abc123", ["test/foo.test.ts"]);
		expect(result.violated).toBe(true);
	});

	test("AC2: result includes file, line, content from violation with assert.", async () => {
		const diff = "@@ -0,0 +5 @@\n+  assert.ok(result)\n";
		_guardDeps.spawn = makeGitDiffSpawn(diff);
		const result = await assertionSiteDiffCheck("/workdir", "abc123", ["test/bar.test.ts"]);
		expect(result.violated).toBe(true);
		if (result.violated) {
			expect(result.file).toBe("test/bar.test.ts");
			expect(typeof result.line).toBe("number");
			expect(result.content).toContain("assert.");
		}
	});

	test("AC3: returns violated:false when added lines contain no assertion patterns", async () => {
		const diff = "@@ -0,0 +1,2 @@\n+const mock = vi.fn();\n+mock.mockReturnValue(42);\n";
		_guardDeps.spawn = makeGitDiffSpawn(diff);
		const result = await assertionSiteDiffCheck("/workdir", "abc123", ["test/foo.test.ts"]);
		expect(result.violated).toBe(false);
	});

	test("AC3: returns violated:false for empty file list without calling spawn", async () => {
		let spawnCalled = false;
		_guardDeps.spawn = mock((..._args: unknown[]) => {
			spawnCalled = true;
			return { exited: Promise.resolve(0), stdout: new Response("").body, stderr: new Response("").body, kill: () => {} };
		}) as unknown as typeof _guardDeps.spawn;
		const result = await assertionSiteDiffCheck("/workdir", "abc123", []);
		expect(result.violated).toBe(false);
		expect(spawnCalled).toBe(false);
	});

	test("AC3: ignores assertion patterns in removed lines (- prefix)", async () => {
		const diff = "@@ -1 +1 @@\n-  expect(old).toBe(42)\n+  // assertion removed\n";
		_guardDeps.spawn = makeGitDiffSpawn(diff);
		const result = await assertionSiteDiffCheck("/workdir", "abc123", ["test/foo.test.ts"]);
		expect(result.violated).toBe(false);
	});
});

// ─── runIsolationGuard — spec-correct behavior ────────────────────────────────

describe("runIsolationGuard — spec-correct behavior (AC4, AC5)", () => {
	withDepsRestore(_guardDeps);

	test("AC5: returns violated:false skipped:true and does NOT call verifyTestWriterIsolation when flag is false", async () => {
		let called = false;
		_guardDeps.verifyTestWriterIsolation = mock(async () => {
			called = true;
			return { passed: true, violations: [], description: "" };
		}) as typeof _guardDeps.verifyTestWriterIsolation;
		const config = makeNaxConfig({ quality: { autofix: { enforceTestWriterIsolation: false } } });
		const result = await runIsolationGuard("/workdir", "abc123", config);
		expect(result.violated).toBe(false);
		expect((result as { skipped?: boolean }).skipped).toBe(true);
		expect(called).toBe(false);
	});

	test("AC4: calls verifyTestWriterIsolation when enforceTestWriterIsolation is true", async () => {
		let called = false;
		_guardDeps.verifyTestWriterIsolation = mock(async () => {
			called = true;
			return { passed: true, violations: [], description: "" };
		}) as typeof _guardDeps.verifyTestWriterIsolation;
		const config = makeNaxConfig({ quality: { autofix: { enforceTestWriterIsolation: true } } });
		await runIsolationGuard("/workdir", "abc123", config);
		expect(called).toBe(true);
	});

	test("AC4: returns violated:true with files when verifyTestWriterIsolation.passed === false", async () => {
		_guardDeps.verifyTestWriterIsolation = mock(async () => ({
			passed: false,
			violations: ["src/foo.ts"],
			description: "edited non-test file",
		})) as typeof _guardDeps.verifyTestWriterIsolation;
		const config = makeNaxConfig();
		const result = await runIsolationGuard("/workdir", "abc123", config);
		expect(result.violated).toBe(true);
		if (result.violated) {
			expect(result.files).toEqual(["src/foo.ts"]);
		}
	});

	test("AC4: returns violated:false (no skipped) when verifyTestWriterIsolation.passed === true", async () => {
		_guardDeps.verifyTestWriterIsolation = mock(async () => ({
			passed: true,
			violations: [],
			description: "",
		})) as typeof _guardDeps.verifyTestWriterIsolation;
		const config = makeNaxConfig();
		const result = await runIsolationGuard("/workdir", "abc123", config);
		expect(result.violated).toBe(false);
		expect((result as { skipped?: boolean }).skipped).toBeUndefined();
	});
});

// ─── revertDiff — spec-correct git command ────────────────────────────────────

describe("revertDiff — spec-correct git command (AC6, AC7)", () => {
	withDepsRestore(_guardDeps);

	test("AC6/7: runs git checkout HEAD -- <files> with all files in one command", async () => {
		const capturedArgs: string[][] = [];
		_guardDeps.spawn = mock((args: string[], _opts?: unknown) => {
			capturedArgs.push(args as string[]);
			return {
				exited: Promise.resolve(0),
				stdout: new Response("").body as ReadableStream<Uint8Array>,
				stderr: new Response("").body as ReadableStream<Uint8Array>,
				kill: () => {},
			};
		}) as unknown as typeof _guardDeps.spawn;
		await revertDiff("/workdir", ["test/foo.test.ts", "test/bar.test.ts"]);
		expect(capturedArgs[0]).toEqual(["git", "checkout", "HEAD", "--", "test/foo.test.ts", "test/bar.test.ts"]);
	});

	test("AC6/7: throws with descriptive message when git checkout exits non-zero", async () => {
		_guardDeps.spawn = makeGitDiffSpawn("fatal: pathspec error", 1);
		let threw = false;
		let errorMsg = "";
		try {
			await revertDiff("/workdir", ["test/foo.test.ts"]);
		} catch (e) {
			threw = true;
			errorMsg = e instanceof Error ? e.message : String(e);
		}
		expect(threw).toBe(true);
		expect(errorMsg).toContain("[autofix-guards] git checkout HEAD failed with exit code 1");
	});
});

// ─── Integration: runAgentRectificationV2 with guards ─────────────────────────

function makeGuardIntegrationCtx() {
	const story = makeStory({ description: "guard integration test" });
	const config = makeNaxConfig({ quality: { autofix: { maxAttempts: 1, maxTotalAttempts: 3 } } });
	return {
		story,
		config,
		workdir: "/tmp/guard-test",
		reviewResult: {
			success: false,
			checks: [
				{
					check: "lint",
					success: false,
					findings: [
						{
							source: "lint",
							severity: "error",
							category: "test-quality",
							message: "mock shape changed",
							file: "test/foo.test.ts",
							fixTarget: "test",
						},
					],
				},
			],
		},
		prd: { feature: "guard-test" },
		agentManager: makeMockAgentManager(),
		runtime: {
			packages: { repo: () => ({ id: "test-pkg" }) },
			outputDir: "/tmp/out",
			signal: new AbortController().signal,
			pidRegistry: { register: () => {} },
		},
		pendingMockStructureHandoffs: [{ files: ["test/foo.test.ts"], reasonDetail: "mock dispatch shape mismatch" }],
		autofixPriorIterations: [],
		testEditDeclarations: [],
		packageView: { id: "test-pkg" },
	} as unknown as Parameters<typeof runAgentRectificationV2>[0];
}

describe("runAgentRectificationV2 — guard integration spec (AC6, AC7)", () => {
	let origCallOp: typeof _cycleDeps.callOp;
	let origCaptureGitRef: typeof _autofixCycleGuardDeps.captureGitRef;
	let origAssertionCheck: typeof _autofixCycleGuardDeps.assertionSiteDiffCheck;
	let origIsolationGuard: typeof _autofixCycleGuardDeps.runIsolationGuard;
	let origRevertDiff: typeof _autofixCycleGuardDeps.revertDiff;
	let origRecheckReview: typeof _autofixDeps.recheckReview;

	beforeEach(() => {
		origCallOp = _cycleDeps.callOp;
		origCaptureGitRef = _autofixCycleGuardDeps.captureGitRef;
		origAssertionCheck = _autofixCycleGuardDeps.assertionSiteDiffCheck;
		origIsolationGuard = _autofixCycleGuardDeps.runIsolationGuard;
		origRevertDiff = _autofixCycleGuardDeps.revertDiff;
		origRecheckReview = _autofixDeps.recheckReview;
		_autofixCycleGuardDeps.captureGitRef = mock(async (_workdir: string) =>
			"abc123",
		) as typeof _autofixCycleGuardDeps.captureGitRef;
		// biome-ignore lint/suspicious/noExplicitAny: test mock for generic callOp signature
		_cycleDeps.callOp = mock(async (_ctx: any, _op: any, _input: any) => ({
			applied: true,
		})) as unknown as typeof _cycleDeps.callOp;
		_autofixDeps.recheckReview = mock(async () => true) as unknown as typeof _autofixDeps.recheckReview;
	});

	afterEach(() => {
		_cycleDeps.callOp = origCallOp;
		_autofixCycleGuardDeps.captureGitRef = origCaptureGitRef;
		_autofixCycleGuardDeps.assertionSiteDiffCheck = origAssertionCheck;
		_autofixCycleGuardDeps.runIsolationGuard = origIsolationGuard;
		_autofixCycleGuardDeps.revertDiff = origRevertDiff;
		_autofixDeps.recheckReview = origRecheckReview;
	});

	test("AC6: when assertionSiteDiffCheck returns violated, revertDiff is called and unresolvedReason starts with assertion_weakening:", async () => {
		let revertCalled = false;
		let revertedFiles: string[] = [];
		_autofixCycleGuardDeps.assertionSiteDiffCheck = mock(async (_workdir, _ref, files) => ({
			violated: true as const,
			file: files[0] ?? "test/foo.test.ts",
			line: 5,
			content: "expect(x).toBe(1)",
		})) as typeof _autofixCycleGuardDeps.assertionSiteDiffCheck;
		_autofixCycleGuardDeps.runIsolationGuard = mock(async () => ({
			violated: false as const,
		})) as typeof _autofixCycleGuardDeps.runIsolationGuard;
		_autofixCycleGuardDeps.revertDiff = mock(async (_workdir, files) => {
			revertCalled = true;
			revertedFiles = files;
		}) as typeof _autofixCycleGuardDeps.revertDiff;

		const ctx = makeGuardIntegrationCtx();
		const result = await runAgentRectificationV2(ctx, undefined, undefined, ctx.workdir);

		expect(revertCalled).toBe(true);
		expect(revertedFiles).toContain("test/foo.test.ts");
		expect(result.unresolvedReason).toBeDefined();
		expect(result.unresolvedReason?.startsWith("assertion_weakening:")).toBe(true);
	});

	test("AC7: when runIsolationGuard returns violated, revertDiff is called and unresolvedReason starts with test_writer_isolation_violation:", async () => {
		let revertCalled = false;
		let revertedFiles: string[] = [];
		_autofixCycleGuardDeps.assertionSiteDiffCheck = mock(async () => ({
			violated: false as const,
		})) as typeof _autofixCycleGuardDeps.assertionSiteDiffCheck;
		_autofixCycleGuardDeps.runIsolationGuard = mock(async () => ({
			violated: true as const,
			files: ["src/foo.ts"],
		})) as typeof _autofixCycleGuardDeps.runIsolationGuard;
		_autofixCycleGuardDeps.revertDiff = mock(async (_workdir, files) => {
			revertCalled = true;
			revertedFiles = files;
		}) as typeof _autofixCycleGuardDeps.revertDiff;

		const ctx = makeGuardIntegrationCtx();
		const result = await runAgentRectificationV2(ctx, undefined, undefined, ctx.workdir);

		expect(revertCalled).toBe(true);
		expect(revertedFiles).toContain("src/foo.ts");
		expect(result.unresolvedReason).toBeDefined();
		expect(result.unresolvedReason?.startsWith("test_writer_isolation_violation:")).toBe(true);
	});
});
