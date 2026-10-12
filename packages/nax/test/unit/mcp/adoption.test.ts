/**
 * #2410 D6 — the end-of-run MCP adoption summary: per configured server, how
 * many sessions were offered its tools, how many called them, and a
 * zero-adoption WARN. Aggregation reads tool-audit files only
 * (transport-agnostic); the block lands in the feature status.json.
 */
import { describe, expect, test } from "bun:test";
import { makeLogger, makeNaxConfig } from "@test/helpers";
import { summarizeMcpAdoptionPhase } from "@/execution/lifecycle/run-completion-phases";
import { buildStatusSnapshot, type RunStateSnapshot } from "@/execution/status-file";
import { _mcpAdoptionDeps, summarizeMcpAdoption } from "@/mcp/adoption";

type AdoptionFile = {
  sessionName?: string;
  toolSurface?: { advertised: { providerId: string; names: string[] }[] };
  calls?: { provider?: string; tool?: string }[];
};

function fsWith(files: Record<string, AdoptionFile>) {
  return {
    readdir: async () => Object.keys(files),
    readFile: async (path: string) => {
      const name = path.split("/").pop() ?? "";
      const body = files[name];
      if (body === undefined) throw new Error(`ENOENT: ${path}`);
      return JSON.stringify(body);
    },
  };
}

const AUDIT_DIR = "/out/tool-audit/feat";

describe("summarizeMcpAdoption", () => {
  test("counts offered, called and never-called servers across session files", async () => {
    const saved = { ..._mcpAdoptionDeps };
    Object.assign(
      _mcpAdoptionDeps,
      fsWith({
        "1-impl.json": {
          sessionName: "impl",
          toolSurface: { advertised: [{ providerId: "cg", names: ["search"] }] },
          calls: [{ provider: "cg", tool: "cg__search" }, { tool: "Read" }],
        },
        "2-adv.json": {
          sessionName: "adv",
          toolSurface: { advertised: [{ providerId: "cg", names: ["search"] }] },
          calls: [],
        },
      }),
    );
    try {
      const summary = await summarizeMcpAdoption({ serverIds: ["cg", "other"], auditDir: AUDIT_DIR });
      expect(summary).toEqual({
        cg: { sessionsOffered: 2, sessionsCalled: 1, totalCalls: 1 },
        other: { sessionsOffered: 0, sessionsCalled: 0, totalCalls: 0 },
      });
    } finally {
      Object.assign(_mcpAdoptionDeps, saved);
    }
  });

  test("files from earlier runs do not mask this run's zero adoption", async () => {
    const saved = { ..._mcpAdoptionDeps };
    Object.assign(
      _mcpAdoptionDeps,
      fsWith({
        "run-1-1-impl.json": {
          sessionName: "impl",
          toolSurface: { advertised: [{ providerId: "cg", names: ["search"] }] },
          calls: [{ provider: "cg", tool: "cg__search" }],
        },
        "run-2-1-adv.json": {
          sessionName: "adv",
          toolSurface: { advertised: [{ providerId: "cg", names: ["search"] }] },
          calls: [],
        },
      }),
    );
    try {
      const summary = await summarizeMcpAdoption({ serverIds: ["cg"], auditDir: AUDIT_DIR, runId: "run-2" });
      expect(summary.cg).toEqual({ sessionsOffered: 1, sessionsCalled: 0, totalCalls: 0 });
    } finally {
      Object.assign(_mcpAdoptionDeps, saved);
    }
  });

  test("a call row naming the tool without a provider field still counts", async () => {
    const saved = { ..._mcpAdoptionDeps };
    Object.assign(
      _mcpAdoptionDeps,
      fsWith({
        "1-s.json": {
          sessionName: "s",
          toolSurface: { advertised: [{ providerId: "cg", names: ["search"] }] },
          calls: [{ tool: "cg__search" }],
        },
      }),
    );
    try {
      const summary = await summarizeMcpAdoption({ serverIds: ["cg"], auditDir: AUDIT_DIR });
      expect(summary.cg).toEqual({ sessionsOffered: 1, sessionsCalled: 1, totalCalls: 1 });
    } finally {
      Object.assign(_mcpAdoptionDeps, saved);
    }
  });

  test("an unreadable file is skipped, not fatal", async () => {
    const saved = { ..._mcpAdoptionDeps };
    _mcpAdoptionDeps.readdir = async () => ["bad.json"];
    _mcpAdoptionDeps.readFile = async () => {
      throw new Error("EACCES");
    };
    try {
      const summary = await summarizeMcpAdoption({ serverIds: ["cg"], auditDir: AUDIT_DIR });
      expect(summary.cg).toEqual({ sessionsOffered: 0, sessionsCalled: 0, totalCalls: 0 });
    } finally {
      Object.assign(_mcpAdoptionDeps, saved);
    }
  });
});

describe("summarizeMcpAdoptionPhase (run-completion phase)", () => {
  const base = (servers: Record<string, { enabled: boolean; stages: Array<"run" | "*"> }>) => ({
    workdir: "/repo",
    feature: "feat",
    config: makeNaxConfig({ mcp: { servers } }),
    outputDir: "/out" as string | undefined,
    runId: "run-2" as string | undefined,
  });

  test("no servers configured: undefined, nothing aggregated", async () => {
    const result = await summarizeMcpAdoptionPhase({ ...base({}), logger: undefined });
    expect(result).toBeUndefined();
  });

  test("a zero-adoption server warns with the offered count", async () => {
    const saved = { ..._mcpAdoptionDeps };
    Object.assign(
      _mcpAdoptionDeps,
      fsWith({
        "run-2-1-adv.json": {
          sessionName: "adv",
          toolSurface: { advertised: [{ providerId: "cg", names: ["search"] }] },
          calls: [],
        },
      }),
    );
    const logger = makeLogger();
    try {
      const result = await summarizeMcpAdoptionPhase({
        ...base({ cg: { enabled: true, stages: ["run"] } }),
        logger,
      });
      expect(result?.cg).toEqual({ sessionsOffered: 1, sessionsCalled: 0, totalCalls: 0 });
      const warns = logger.calls.filter((call) => call.level === "warn");
      expect(warns).toHaveLength(1);
      expect(warns[0]?.message).toContain("cg");
      expect(warns[0]?.message).toContain("never called");
    } finally {
      Object.assign(_mcpAdoptionDeps, saved);
    }
  });
});

describe("status.json projection", () => {
  test("mcpAdoption rides the snapshot like advisor", () => {
    const state: RunStateSnapshot = {
      runId: "r1",
      feature: "feat",
      startedAt: "t",
      runStatus: "running",
      dryRun: false,
      pid: 1,
      prd: { project: "p", feature: "feat", branchName: "b", createdAt: "t", updatedAt: "t", userStories: [] },
      totalCost: 0,
      costLimit: null,
      currentStory: null,
      iterations: 1,
      startTimeMs: 0,
      mcpAdoption: { cg: { sessionsOffered: 2, sessionsCalled: 1, totalCalls: 1 } },
    };
    const snapshot = buildStatusSnapshot(state);
    expect(snapshot.mcpAdoption).toEqual({ cg: { sessionsOffered: 2, sessionsCalled: 1, totalCalls: 1 } });
  });
});
