/**
 * Acceptance Test: nax diagnose CLI
 *
 * Validates that the nax diagnose command meets all acceptance criteria.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { diagnoseCommand } from "../../../src/cli/diagnose";
import type { PRD } from "../../../src/prd";
import { savePRD } from "../../../src/prd";
import type { NaxStatusFile } from "../../../src/execution/status-file";

// Test fixture directory
let testDir: string;

beforeEach(() => {
	// Create unique test directory
	testDir = join(tmpdir(), `nax-diagnose-acceptance-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(testDir, { recursive: true });
	mkdirSync(join(testDir, "nax", "features"), { recursive: true });
});

afterEach(() => {
	// Clean up test directory
	if (existsSync(testDir)) {
		rmSync(testDir, { recursive: true, force: true });
	}
});

/**
 * Create a minimal PRD fixture
 */
function createPRD(feature: string, stories: Array<Partial<PRD["userStories"][0]>>): PRD {
	return {
		project: "test-project",
		feature,
		branchName: "feature/test",
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-01T00:00:00Z",
		userStories: stories.map((s, i) => ({
			id: s.id ?? `US-${String(i + 1).padStart(3, "0")}`,
			title: s.title ?? "Test Story",
			description: s.description ?? "Test description",
			acceptanceCriteria: s.acceptanceCriteria ?? [],
			tags: s.tags ?? [],
			dependencies: s.dependencies ?? [],
			status: s.status ?? "pending",
			passes: s.passes ?? false,
			escalations: s.escalations ?? [],
			attempts: s.attempts ?? 0,
			priorErrors: s.priorErrors ?? [],
			...s,
		})),
	};
}

/**
 * Create a status.json fixture
 */
async function createStatusFile(
	dir: string,
	feature: string,
	overrides: Partial<NaxStatusFile> = {},
): Promise<void> {
	const status: NaxStatusFile = {
		version: 1,
		run: {
			id: "run-001",
			feature,
			startedAt: "2026-01-01T10:00:00Z",
			status: "running",
			dryRun: false,
			pid: process.pid,
			...overrides.run,
		},
		progress: {
			total: 3,
			passed: 1,
			failed: 1,
			paused: 0,
			blocked: 0,
			pending: 1,
			...overrides.progress,
		},
		cost: {
			spent: 0.05,
			limit: null,
			...overrides.cost,
		},
		current: null,
		iterations: 1,
		updatedAt: "2026-01-01T10:30:00Z",
		durationMs: 1800000,
		...overrides,
	};

	await Bun.write(join(dir, ".nax-status.json"), JSON.stringify(status, null, 2));
}

/**
 * Create a lock file fixture
 */
async function createLockFile(dir: string, pid: number): Promise<void> {
	await Bun.write(
		join(dir, "nax.lock"),
		JSON.stringify({
			pid,
			timestamp: Date.now(),
		}),
	);
}

// ============================================================================
// AC1: Basic diagnosis with all 5 sections
// ============================================================================

describe("AC1: nax diagnose reads last run and prints all 5 sections", () => {
	test("prints Run Summary, Story Breakdown, Failure Analysis, Lock Check, Recommendations", async () => {
		const feature = "test-feature";
		const featureDir = join(testDir, "nax", "features", feature);
		mkdirSync(featureDir, { recursive: true });

		const prd = createPRD(feature, [
			{ id: "US-001", title: "Passed Story", status: "passed", passes: true, attempts: 1 },
			{
				id: "US-002",
				title: "Failed Story",
				status: "failed",
				passes: false,
				attempts: 3,
				priorErrors: ["tests-failing", "tests-failing"],
			},
			{ id: "US-003", title: "Pending Story", status: "pending", passes: false, attempts: 0 },
		]);

		await savePRD(prd, join(featureDir, "prd.json"));
		await createStatusFile(testDir, feature);

		let output = "";
		const originalLog = console.log;
		console.log = (...args: unknown[]) => {
			output += args.join(" ") + "\n";
		};

		try {
			await diagnoseCommand({ feature, workdir: testDir, verbose: true });

			// Verify all sections present
			expect(output).toContain("Diagnosis Report");
			expect(output).toContain("Run Summary");
			expect(output).toContain("Story Breakdown");
			expect(output).toContain("Failure Analysis");
			expect(output).toContain("Lock Check");
			expect(output).toContain("Recommendations");

			// Verify counts
			expect(output).toContain("Passed:      1");
			expect(output).toContain("Failed:      1");
			expect(output).toContain("Pending:     1");
		} finally {
			console.log = originalLog;
		}
	});
});

// ============================================================================
// AC2: Pattern classification for failed stories
// ============================================================================

describe("AC2: Each failed story shows pattern classification", () => {
	test("classifies all failure patterns correctly", async () => {
		const feature = "patterns-feature";
		const featureDir = join(testDir, "nax", "features", feature);
		mkdirSync(featureDir, { recursive: true });

		const prd = createPRD(feature, [
			{
				id: "US-001",
				title: "Greenfield Story",
				status: "failed",
				failureCategory: "greenfield-no-tests",
				attempts: 1,
			},
			{
				id: "US-002",
				title: "Test Mismatch",
				status: "failed",
				priorErrors: ["tests-failing", "tests-failing"],
				attempts: 2,
			},
			{
				id: "US-003",
				title: "Isolation Violation",
				status: "failed",
				failureCategory: "isolation-violation",
				attempts: 1,
			},
		]);

		await savePRD(prd, join(featureDir, "prd.json"));

		let output = "";
		const originalLog = console.log;
		console.log = (...args: unknown[]) => {
			output += args.join(" ") + "\n";
		};

		try {
			await diagnoseCommand({ feature, workdir: testDir });

			expect(output).toContain("GREENFIELD_TDD");
			expect(output).toContain("TEST_MISMATCH");
			expect(output).toContain("ISOLATION_VIOLATION");
		} finally {
			console.log = originalLog;
		}
	});
});

// ============================================================================
// AC3: Stale lock detection
// ============================================================================

describe("AC3: Stale nax.lock detection", () => {
	test("detects stale lock and shows fix command", async () => {
		const feature = "locked-feature";
		const featureDir = join(testDir, "nax", "features", feature);
		mkdirSync(featureDir, { recursive: true });

		const prd = createPRD(feature, [{ id: "US-001", title: "Test Story", status: "pending" }]);
		await savePRD(prd, join(featureDir, "prd.json"));
		await createLockFile(testDir, 999999); // Dead PID

		let output = "";
		const originalLog = console.log;
		console.log = (...args: unknown[]) => {
			output += args.join(" ") + "\n";
		};

		try {
			await diagnoseCommand({ feature, workdir: testDir });

			expect(output).toContain("Stale lock detected");
			expect(output).toContain("rm nax.lock");
		} finally {
			console.log = originalLog;
		}
	});
});

// ============================================================================
// AC4: JSON output mode
// ============================================================================

describe("AC4: --json flag outputs machine-readable JSON", () => {
	test("outputs valid JSON with all report fields", async () => {
		const feature = "json-feature";
		const featureDir = join(testDir, "nax", "features", feature);
		mkdirSync(featureDir, { recursive: true });

		const prd = createPRD(feature, [
			{ id: "US-001", title: "Passed Story", status: "passed", passes: true },
			{ id: "US-002", title: "Failed Story", status: "failed", attempts: 2 },
		]);

		await savePRD(prd, join(featureDir, "prd.json"));

		let output = "";
		const originalLog = console.log;
		console.log = (...args: unknown[]) => {
			output += args.join(" ") + "\n";
		};

		try {
			await diagnoseCommand({ feature, workdir: testDir, json: true });

			const report = JSON.parse(output);

			expect(report).toHaveProperty("runSummary");
			expect(report).toHaveProperty("storyBreakdown");
			expect(report).toHaveProperty("failureAnalysis");
			expect(report).toHaveProperty("lockCheck");
			expect(report).toHaveProperty("recommendations");
			expect(report).toHaveProperty("dataSources");

			expect(report.runSummary.storiesPassed).toBe(1);
			expect(report.runSummary.storiesFailed).toBe(1);
		} finally {
			console.log = originalLog;
		}
	});
});

// ============================================================================
// AC5: Graceful degradation when events.jsonl missing
// ============================================================================

describe("AC5: Works gracefully when events.jsonl missing", () => {
	test("uses PRD + git log only and prints note", async () => {
		const feature = "no-events-feature";
		const featureDir = join(testDir, "nax", "features", feature);
		mkdirSync(featureDir, { recursive: true });

		const prd = createPRD(feature, [{ id: "US-001", title: "Test Story", status: "passed", passes: true }]);
		await savePRD(prd, join(featureDir, "prd.json"));

		let output = "";
		const originalLog = console.log;
		console.log = (...args: unknown[]) => {
			output += args.join(" ") + "\n";
		};

		try {
			await diagnoseCommand({ feature, workdir: testDir });

			expect(output).toContain("Diagnosis Report");
			expect(output).toContain("events.jsonl not found");
		} finally {
			console.log = originalLog;
		}
	});
});

// ============================================================================
// AC6: -f and -d flags for targeting
// ============================================================================

describe("AC6: -f <feature> and -d <workdir> flags work", () => {
	test("diagnoses specific feature with -f flag", async () => {
		const feature = "specific-feature";
		const featureDir = join(testDir, "nax", "features", feature);
		mkdirSync(featureDir, { recursive: true });

		const prd = createPRD(feature, [{ id: "US-001", title: "Specific Story", status: "passed", passes: true }]);
		await savePRD(prd, join(featureDir, "prd.json"));

		let output = "";
		const originalLog = console.log;
		console.log = (...args: unknown[]) => {
			output += args.join(" ") + "\n";
		};

		try {
			await diagnoseCommand({ feature, workdir: testDir, verbose: true });

			expect(output).toContain(feature);
			expect(output).toContain("Specific Story");
		} finally {
			console.log = originalLog;
		}
	});
});

// ============================================================================
// AC7: AUTO_RECOVERED shown as INFO not ERROR
// ============================================================================

describe("AC7: AUTO_RECOVERED stories shown as INFO", () => {
	test("displays AUTO_RECOVERED with INFO level, not ERROR", async () => {
		const feature = "recovered-feature";
		const featureDir = join(testDir, "nax", "features", feature);
		mkdirSync(featureDir, { recursive: true });

		const prd = createPRD(feature, [
			{
				id: "US-001",
				title: "Recovered Story",
				status: "passed",
				passes: true,
				priorErrors: ["greenfield-no-tests"],
				attempts: 2,
			},
		]);

		await savePRD(prd, join(featureDir, "prd.json"));

		let output = "";
		const originalLog = console.log;
		console.log = (...args: unknown[]) => {
			output += args.join(" ") + "\n";
		};

		try {
			await diagnoseCommand({ feature, workdir: testDir });

			expect(output).toContain("INFO");
			expect(output).toContain("AUTO_RECOVERED");
			expect(output).not.toContain("ERROR US-001");
		} finally {
			console.log = originalLog;
		}
	});
});

// ============================================================================
// AC8: TypeScript compiles cleanly
// ============================================================================

describe("AC8: TypeScript compiles cleanly", () => {
	test("bun x tsc --noEmit passes", async () => {
		const result = Bun.spawnSync(["bun", "x", "tsc", "--noEmit"], {
			cwd: join(__dirname, "../../.."),
			stdout: "pipe",
			stderr: "pipe",
		});

		expect(result.exitCode).toBe(0);
	}, 60000);
});
