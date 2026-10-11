/**
 * #2410 D6 — the end-of-run MCP adoption summary: per configured server, how
 * many sessions were offered its tools, how many called them, and a
 * zero-adoption WARN. Aggregation reads tool-audit files only
 * (transport-agnostic); the block lands in the feature status.json.
 */
import { describe, expect, test } from "bun:test";
import type { Logger } from "@/logger";
import { _mcpAdoptionDeps, summarizeMcpAdoption } from "@/mcp/adoption";
import { summarizeMcpAdoptionPhase } from "@/execution/lifecycle/run-completion-phases";
import { buildStatusSnapshot, type RunStateSnapshot } from "@/execution/status-file";
import { makeNaxConfig } from "@test/helpers";

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
  const base = (servers: Record<string, unknown>) => ({
    workdir: "/repo",
    feature: "feat",
    runtime: { outputDir: "/out" },
    config: makeNaxConfig({ mcp: { servers } as never }),
  });

  test("no servers configured: undefined, nothing aggregated", async () => {
    const result = await summarizeMcpAdoptionPhase({ options: base({}) as never, logger: undefined });
    expect(result).toBeUndefined();
  });

  test("a zero-adoption server warns with the offered count", async () => {
    const saved = { ..._mcpAdoptionDeps };
    Object.assign(
      _mcpAdoptionDeps,
      fsWith({
        "1-adv.json": { sessionName: "adv", toolSurface: { advertised: [{ providerId: "cg", names: ["search"] }] }, calls: [] },
      }),
    );
    const warnings: unknown[] = [];
    const logger = { warn: (stage: string, msg: string, ctx: unknown) => warnings.push({ stage, msg, ctx }) } as unknown as Logger;
    try {
      const result = await summarizeMcpAdoptionPhase({ options: base({ cg: { enabled: true, stages: ["run"] } }) as never, logger });
      expect(result?.cg).toEqual({ sessionsOffered: 1, sessionsCalled: 0, totalCalls: 0 });
      expect(warnings).toHaveLength(1);
      expect((warnings[0] as { msg: string }).msg).toContain("cg");
      expect((warnings[0] as { msg: string }).msg).toContain("never called");
    } finally {
      Object.assign(_mcpAdoptionDeps, saved);
    }
  });
});

describe("status.json projection", () => {
  test("mcpAdoption rides the snapshot like advisor", () => {
    const state = {
      runId: "r1",
      feature: "feat",
      startedAt: "t",
      runStatus: "completed" as const,
      dryRun: false,
      pid: 1,
      prd: { userStories: [] },
      totalCost: 0,
      costLimit: null,
      currentStory: null,
      iterations: 1,
      startTimeMs: 0,
      mcpAdoption: { cg: { sessionsOffered: 2, sessionsCalled: 1, totalCalls: 1 } },
    } as unknown as RunStateSnapshot;
    const snapshot = buildStatusSnapshot(state);
    expect(snapshot.mcpAdoption).toEqual({ cg: { sessionsOffered: 2, sessionsCalled: 1, totalCalls: 1 } });
  });
});
