import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import type { Advisor, BatchRequest, BatchResult } from "@/advisor";
import { type PreflightFile, preflightPath, runPreflight } from "@/workflow/preflight";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.map(cleanupTempDir));
  dirs.length = 0;
});

function advisorReturning(result: BatchResult): Advisor & { calls: BatchRequest[] } {
  const calls: BatchRequest[] = [];
  return {
    calls,
    advise: async () => ({ decision: null }),
    recordReuse: async () => null,
    adviseBatch: async (r) => {
      calls.push(r);
      return result;
    },
  };
}

describe("runPreflight", () => {
  test("writes preflight.json and a ledger Ruling line per affected story", async () => {
    const runDir = makeTempDir("wf-pf-");
    dirs.push(runDir);
    const advisor = advisorReturning({
      kind: "preflight",
      overlap: [{ storyId: "US-1", specSections: ["3.2"] }],
      items: [
        {
          question: {
            id: "Q-1",
            kind: "preflight",
            feature: "f",
            storyId: "US-2",
            askedAtSha: "a",
            summary: "30d vs 14d",
            evidence: [],
            options: [],
          },
          decision: {
            id: "D-1",
            questionId: "Q-1",
            kind: "preflight",
            chosenOptionId: "B",
            appliesTo: ["US-2", "US-3"],
            action: { type: "supersede", target: { kind: "ac", storyId: "US-2", acId: "AC-3" }, newText: "14 days" },
            rationale: "spec is newer",
            confidence: "high",
            reversible: true,
            needsHumanConfirm: true,
            decidedAt: "t",
            model: "m",
            memoryMode: "stateless",
            auditRef: "a",
          },
        },
        {
          question: {
            id: "Q-2",
            kind: "preflight",
            feature: "f",
            storyId: "US-3",
            askedAtSha: "a",
            summary: "tz",
            evidence: [],
            options: [],
          },
          decision: null,
          fallbackReason: "optionId B needs an AC reference",
        },
      ],
    });
    const lines: string[] = [];
    const file = await runPreflight({
      advisor,
      runDir,
      storyIds: ["US-1", "US-2", "US-3"],
      ledger: async (s, t) => {
        lines.push(`${s}: ${t}`);
      },
    });
    expect(advisor.calls[0]).toMatchObject({ kind: "preflight", storyIds: ["US-1", "US-2", "US-3"] });
    expect(file.conflicts.map((c) => [c.questionId, c.decisionId, c.action])).toEqual([
      ["Q-1", "D-1", "supersede"],
      ["Q-2", null, "hold"],
    ]);
    expect(await Bun.file(preflightPath(runDir)).json()).toEqual(file);
    expect(lines).toEqual([
      "US-2: Ruling: pre-flight D-1: supersede US-2 AC-3 — spec is newer — high confidence; reversible; needs confirmation",
      "US-3: Ruling: pre-flight D-1: supersede US-2 AC-3 — spec is newer — high confidence; reversible; needs confirmation",
      "US-3: Ruling: pre-flight hold (default) — optionId B needs an AC reference — the story runs under the spec as written",
    ]);
  });

  test("existing valid preflight.json is reused: no advisor call, no ledger lines (resume)", async () => {
    const runDir = makeTempDir("wf-pf-");
    dirs.push(runDir);
    const saved: PreflightFile = { schemaVersion: 1, storyIds: ["US-1"], overlap: [], conflicts: [] };
    await Bun.write(join(runDir, "preflight.json"), JSON.stringify(saved));
    const advisor = advisorReturning({ kind: "preflight", overlap: [], items: [] });
    const lines: string[] = [];
    const file = await runPreflight({
      advisor,
      runDir,
      storyIds: ["US-1"],
      ledger: async (s, t) => {
        lines.push(`${s}: ${t}`);
      },
    });
    expect(advisor.calls).toHaveLength(0);
    expect(file).toEqual(saved);
    expect(lines).toEqual([]);
  });

  test.each([
    ["legacy missing storyIds", JSON.stringify({ schemaVersion: 1, overlap: [], conflicts: [] })],
    ["corrupt JSON", "{not json"],
    ["wrong shape", '{"schemaVersion":2}'],
    [
      "failed pre-flight",
      JSON.stringify({ schemaVersion: 1, storyIds: ["US-1"], overlap: [], conflicts: [], fallbackReason: "boom" }),
    ],
  ])("unusable existing file (%s) re-runs the advisor and writes a valid file", async (_name, content) => {
    const runDir = makeTempDir("wf-pf-");
    dirs.push(runDir);
    await Bun.write(join(runDir, "preflight.json"), content);
    const advisor = advisorReturning({ kind: "preflight", overlap: [], items: [] });
    const file = await runPreflight({ advisor, runDir, storyIds: ["US-1"], ledger: async () => {} });
    expect(advisor.calls).toHaveLength(1);
    expect(await Bun.file(preflightPath(runDir)).json()).toEqual(file);
    expect(file.schemaVersion).toBe(1);
  });

  test("zero conflicts still writes the file (Review Focus 5)", async () => {
    const runDir = makeTempDir("wf-pf-");
    dirs.push(runDir);
    const file = await runPreflight({
      advisor: advisorReturning({ kind: "preflight", overlap: [], items: [] }),
      runDir,
      storyIds: ["US-1"],
      ledger: async () => {},
    });
    expect(file.storyIds).toEqual(["US-1"]);
    expect(file.conflicts).toEqual([]);
    expect(await Bun.file(preflightPath(runDir)).exists()).toBe(true);
  });
});

describe("preflight.json reuse checks element shape (PR3 M6)", () => {
  test("a conflict missing storyIds is not reused: pre-flight runs again", async () => {
    const runDir = makeTempDir("wf-pf-shape-");
    dirs.push(runDir);
    await Bun.write(
      preflightPath(runDir),
      JSON.stringify({
        schemaVersion: 1,
        storyIds: ["US-1"],
        overlap: [],
        conflicts: [{ questionId: "Q-1", summary: "s", decisionId: null, action: "hold" }],
      }),
    );
    const advisor = advisorReturning({ kind: "preflight", overlap: [], items: [] });
    await runPreflight({ advisor, runDir, storyIds: ["US-1"], ledger: async () => {} });
    expect(advisor.calls).toHaveLength(1);
  });

  test("an overlap entry with a non-string section is not reused", async () => {
    const runDir = makeTempDir("wf-pf-shape-");
    dirs.push(runDir);
    await Bun.write(
      preflightPath(runDir),
      JSON.stringify({
        schemaVersion: 1,
        storyIds: ["US-1"],
        overlap: [{ storyId: "US-1", specSections: [3] }],
        conflicts: [],
      }),
    );
    const advisor = advisorReturning({ kind: "preflight", overlap: [], items: [] });
    await runPreflight({ advisor, runDir, storyIds: ["US-1"], ledger: async () => {} });
    expect(advisor.calls).toHaveLength(1);
  });

  test("a well-formed file is reused (no advisor call)", async () => {
    const runDir = makeTempDir("wf-pf-shape-");
    dirs.push(runDir);
    const file: PreflightFile = {
      schemaVersion: 1,
      storyIds: ["US-1"],
      overlap: [{ storyId: "US-1", specSections: ["3"] }],
      conflicts: [{ questionId: "Q-1", storyIds: ["US-1"], summary: "s", decisionId: "D-1", action: "supersede" }],
    };
    await Bun.write(preflightPath(runDir), JSON.stringify(file));
    const advisor = advisorReturning({ kind: "preflight", overlap: [], items: [] });
    expect(await runPreflight({ advisor, runDir, storyIds: ["US-1"], ledger: async () => {} })).toEqual(file);
    expect(advisor.calls).toHaveLength(0);
  });
});
