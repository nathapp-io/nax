import { describe, expect, it, mock } from "bun:test";
import { join } from "node:path";
import {
  persistBakeoffResult,
  renderBakeoffReport,
  runBakeoff,
  runContestant,
  validateContestants,
} from "@/bakeoff";
import type {
  BakeoffOptions,
  BakeoffResult,
  ContestantOptions,
  ContestantResult,
} from "@/bakeoff";
import type { NaxConfig } from "@/config";
import { withTempDir } from "@test/helpers";

// ── Shared helpers ────────────────────────────────────────────────────────────

function baseConfig(): NaxConfig {
  return {
    agent: {
      default: "claude",
      fallback: { enabled: false, map: {}, maxHopsPerStory: 2 },
    },
  } as unknown as NaxConfig;
}

function makeContestantResult(overrides: Partial<ContestantResult> = {}): ContestantResult {
  return {
    agent: "claude",
    status: "passed",
    storiesPassed: 1,
    storiesTotal: 1,
    costUsd: 1.0,
    wallTimeMs: 1000,
    ...overrides,
  };
}

function makeBakeoffOptions(overrides: Partial<BakeoffOptions> = {}): BakeoffOptions {
  return {
    agents: ["claude"],
    feature: "test-feature",
    projectRoot: "/tmp/test-project",
    outputDir: "/tmp/test-output",
    config: baseConfig(),
    ...overrides,
  };
}

// ── AC-1 ─────────────────────────────────────────────────────────────────────

describe("AC-1: validateContestants rejects unknown agents; coordinator skips runContestant", () => {
  it(
    "AC-1a: validateContestants returns non-empty errors and empty validAgents for fully unknown agent names",
    () => {
      const result = validateContestants(
        ["agent-does-not-exist-xyz-11111", "another-nonexistent-abc-22222"],
        { isInstalled: () => false, hasAcpAdapterEntry: () => false },
      );

      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.validAgents.length).toBe(0);
    },
  );

  it(
    "AC-1b: coordinator does not invoke runContestant when validateContestants returns errors",
    async () => {
      const runContestantSpy = mock(async (_agent: string, _opts: ContestantOptions) =>
        makeContestantResult(),
      );

      try {
        await runBakeoff(makeBakeoffOptions({ agents: ["unknown-agent-xyz"] }), {
          validateContestants: () => ({
            errors: [{ agent: "unknown-agent-xyz", reason: "unknown-agent" as const }],
            validAgents: [] as string[],
          }),
          runContestant: runContestantSpy,
          persistBakeoffResult: async () => {},
          rankContestants: (r: ContestantResult[]) => r,
        });
      } catch {
        // throwing on validation failure is acceptable — what matters is runContestant was skipped
      }

      expect(runContestantSpy).not.toHaveBeenCalled();
    },
  );
});

// ── AC-2 ─────────────────────────────────────────────────────────────────────

describe("AC-2: WorktreeManager.create() failure → DNF ContestantResult, no hang", () => {
  it(
    "AC-2: resolves (not throws) with dnf-prefixed status, non-empty error string, within 5000 ms",
    async () => {
      const options: ContestantOptions = {
        projectRoot: "/tmp/test-project",
        config: baseConfig(),
      };

      const t0 = Date.now();
      const result = await runContestant("claude", options, {
        worktreeManager: {
          create: async (_root: string, _storyId: string) => {
            throw new Error("simulated worktree init failure");
          },
          remove: async () => {},
        },
        pipeline: async () => ({ results: [], metrics: [] }),
      });
      const elapsedMs = Date.now() - t0;

      expect(result).toBeDefined();
      expect(result.status).toMatch(/^dnf/i);
      expect(typeof result.error).toBe("string");
      expect((result.error as string).length).toBeGreaterThan(0);
      expect(elapsedMs).toBeLessThan(5000);
    },
  );
});

// ── AC-3 ─────────────────────────────────────────────────────────────────────

describe("AC-3: reviewFindings aggregated from StoryMetrics.reviewMetrics across all stories", () => {
  it(
    "AC-3: ContestantResult.metrics.reviewFindings equals total findings count across all story metrics",
    async () => {
      const findingsStory1 = ["lint-error-A", "type-error-B"];
      const findingsStory2 = ["style-issue-C"];
      const expectedTotal = findingsStory1.length + findingsStory2.length; // 3

      const result = await runContestant(
        "claude",
        { projectRoot: "/tmp/test-project", config: baseConfig() },
        {
          worktreeManager: {
            create: async () => {},
            remove: async () => {},
          },
          pipeline: async () => ({
            results: [{ status: "passed" }, { status: "passed" }],
            metrics: [
              // biome-ignore lint: acceptance test — reviewMetrics is a new field to be added
              {
                cost: 0.5,
                durationMs: 500,
                attempts: 1,
                reviewMetrics: [{ findings: findingsStory1 }],
              } as any,
              // biome-ignore lint: acceptance test — reviewMetrics is a new field to be added
              {
                cost: 0.5,
                durationMs: 500,
                attempts: 1,
                reviewMetrics: [{ findings: findingsStory2 }],
              } as any,
            ],
          }),
        },
      );

      const reviewFindings = (result as any).metrics?.reviewFindings;
      expect(reviewFindings, "ContestantResult.metrics.reviewFindings must be defined").toBeDefined();
      expect(reviewFindings).toBe(expectedTotal);
    },
  );
});

// ── AC-4 ─────────────────────────────────────────────────────────────────────

describe("AC-4: runBakeoff returns exitCode 0, non-empty winner agentId, and matching summaryLine", () => {
  it(
    "AC-4: outcome is 0 (exitCode 0), winner.agent is a non-empty string, summaryLine matches /^(winning|winner|top|best)[:\\s].+/i and contains the winner name",
    async () => {
      const winnerContestant = makeContestantResult({
        agent: "claude",
        status: "passed",
        storiesPassed: 2,
      });
      const loserContestant = makeContestantResult({
        agent: "codex",
        status: "failed",
        storiesPassed: 0,
      });

      const result = await runBakeoff(
        makeBakeoffOptions({ agents: ["claude", "codex"] }),
        {
          validateContestants: () => ({ errors: [], validAgents: ["claude", "codex"] }),
          runContestant: async (agent: string) =>
            agent === "claude" ? winnerContestant : loserContestant,
          rankContestants: (_r: ContestantResult[]) => [winnerContestant, loserContestant],
          persistBakeoffResult: async () => {},
        },
      );

      // outcome 0 maps to exitCode 0 (at least one contestant finished)
      const exitCode = (result as any).exitCode ?? result.outcome;
      expect(exitCode).toBe(0);

      // winner must name a non-empty agentId string
      expect(result.winner).toBeDefined();
      const winnerAgent = result.winner!.agent;
      expect(typeof winnerAgent).toBe("string");
      expect(winnerAgent.length).toBeGreaterThan(0);

      // summaryLine must be present, match the pattern, and contain the winner's name
      const summaryLine = (result as any).summaryLine as string | undefined;
      expect(summaryLine, "summaryLine must be defined on BakeoffResult").toBeDefined();
      expect(summaryLine).toMatch(/^(winning|winner|top|best)[:\s].+/i);
      expect(summaryLine).toContain(winnerAgent);
    },
  );
});

// ── AC-5 ─────────────────────────────────────────────────────────────────────

describe("AC-5: bakeoff.json written to outputDir; all-DNF contestants persisted correctly", () => {
  it(
    "AC-5: bakeoff.json exists with contestants.length === input count and every entry has a DNF-class status",
    async () => {
      await withTempDir(async (tmpDir: string) => {
        const agents = ["claude", "codex", "gemini"];

        await runBakeoff(makeBakeoffOptions({ agents, outputDir: tmpDir }), {
          validateContestants: () => ({ errors: [], validAgents: agents }),
          runContestant: async (agent: string) =>
            makeContestantResult({
              agent,
              status: "dnf-crashed",
              storiesPassed: 0,
              error: "simulated crash",
            }),
          rankContestants: (r: ContestantResult[]) => r,
          // persistBakeoffResult not overridden → real implementation writes the file
        });

        const filePath = join(tmpDir, "bakeoff.json");
        const raw = await Bun.file(filePath).text();
        const parsed = JSON.parse(raw) as BakeoffResult;

        expect(Array.isArray(parsed.contestants)).toBe(true);
        expect(parsed.contestants.length).toBe(agents.length);

        for (const contestant of parsed.contestants) {
          // any DNF variant (dnf-crashed, dnf-timeout, dnf-killed) or literal "DNF" satisfies
          expect(contestant.status).toMatch(/^dnf/i);
        }
      });
    },
  );
});

// ── AC-6 ─────────────────────────────────────────────────────────────────────

describe("AC-6: bakeoff.json story field; renderBakeoffReport scoped to story US-002", () => {
  it(
    "AC-6: persisted JSON has story='US-002'; report includes US-002 contestants and excludes other-story contestants",
    async () => {
      await withTempDir(async (tmpDir: string) => {
        const storyId = "US-002";

        const us002Contestant = {
          ...makeContestantResult({ agent: "claude", status: "passed" }),
          story: storyId,
        } as ContestantResult & { story: string };

        const otherStoryContestant = {
          ...makeContestantResult({ agent: "gemini", status: "passed" }),
          story: "US-001",
        } as ContestantResult & { story: string };

        const bakeoffResult = await runBakeoff(
          makeBakeoffOptions({
            agents: ["claude", "gemini"],
            outputDir: tmpDir,
            storyId,
          }),
          {
            validateContestants: () => ({
              errors: [],
              validAgents: ["claude", "gemini"],
            }),
            runContestant: async (agent: string) =>
              agent === "claude" ? us002Contestant : otherStoryContestant,
            rankContestants: (_r: ContestantResult[]) => [us002Contestant, otherStoryContestant],
            persistBakeoffResult,
          },
        );

        // AC-6a: persisted file must have story === "US-002"
        const raw = await Bun.file(join(tmpDir, "bakeoff.json")).text();
        const parsed = JSON.parse(raw) as any;
        expect(parsed.story).toBe(storyId);

        // AC-6b: report must include US-002 contestants and exclude those from other stories
        const report = renderBakeoffReport(bakeoffResult);
        expect(report).toContain("claude");     // story US-002 → must appear
        expect(report).not.toContain("gemini"); // story US-001 → must NOT appear
      });
    },
  );
});