import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import type { PostReviewInput } from "@/bot";
import { settleFindingOrigins } from "@/bot/finding-origin";
import { findingKey } from "@/bot/render";
import { getLogger, initLogger, resetLogger } from "@/logger";
import type { PrFinding, PrReviewVerdict } from "@/operations";

const FILE = "src/a.ts";
const LINE = 12;
const PUSH = "c".repeat(40);
const ISSUE = "Lock leaks";
const KEY = findingKey({ file: FILE, issue: ISSUE });
const EVIDENCE = "the fix added this line";

const fixGap: PrFinding = {
  kind: "quality",
  severity: "important",
  issue: ISSUE,
  file: FILE,
  line: LINE,
  origin: "fix-gap",
  originEvidence: EVIDENCE,
};

/** A verdict whose findings are the ones the case under test needs. */
function verdictOf(...findings: PrFinding[]): PrReviewVerdict {
  return {
    intent: "pass",
    quality: "changes",
    findings,
    threads: [],
    comments: [],
    cannotVerify: [],
    inspectedFiles: [],
  };
}

/** The lineage a review read: one entry per key a reachable push wrote, one unknown key per failed read. */
function lineageOf(input: {
  readonly lineage?: readonly string[];
  readonly unknown?: readonly string[];
}): PostReviewInput["lineage"] {
  return {
    lineage: new Map((input.lineage ?? []).map((key) => [key, { generation: 1, parents: ["f-a"], pushSha: PUSH }])),
    unknown: new Set(input.unknown ?? []),
    unreachable: 0,
  };
}

const noOwnThreads = new Set<string>();
const noFacts = { lineage: undefined, ownThreadKeys: noOwnThreads };

/** The one finding a single-finding case returns. */
function only(verdict: PrReviewVerdict): PrFinding {
  const finding = verdict.findings[0];
  if (finding === undefined) throw new Error("the settled verdict carried no finding");
  return finding;
}

describe("settleFindingOrigins", () => {
  test("AC-1 keeps a fix-gap claim whose key a push wrote and the bot owns no thread for", () => {
    const settled = settleFindingOrigins(verdictOf(fixGap), {
      lineage: lineageOf({ lineage: [KEY] }),
      ownThreadKeys: noOwnThreads,
    });

    expect(only(settled)).toMatchObject({ origin: "fix-gap", originEvidence: EVIDENCE });
  });

  test("AC-2 reads a fix-gap claim as pr when no push wrote its line", () => {
    const settled = settleFindingOrigins(verdictOf(fixGap), {
      lineage: lineageOf({ lineage: [] }),
      ownThreadKeys: noOwnThreads,
    });

    expect(only(settled).origin).toBe("pr");
  });

  test("AC-3 drops the origin evidence of a fix-gap claim it reads as pr", () => {
    const settled = settleFindingOrigins(verdictOf(fixGap), {
      lineage: lineageOf({ lineage: [] }),
      ownThreadKeys: noOwnThreads,
    });

    expect(only(settled)).not.toHaveProperty("originEvidence");
  });

  test("AC-4 reads a fix-gap claim as pr when the bot already owns an inline thread for its key", () => {
    const settled = settleFindingOrigins(verdictOf(fixGap), {
      lineage: lineageOf({ lineage: [KEY] }),
      ownThreadKeys: new Set([KEY]),
    });

    expect(only(settled).origin).toBe("pr");
  });

  test("AC-5 reads a fix-gap claim as pr when the lineage read failed for its key", () => {
    const settled = settleFindingOrigins(verdictOf(fixGap), {
      lineage: lineageOf({ unknown: [KEY] }),
      ownThreadKeys: noOwnThreads,
    });

    expect(only(settled).origin).toBe("pr");
  });

  test("AC-6 reads a fix-gap claim with no file as pr", () => {
    const unanchored: PrFinding = { kind: "quality", severity: "important", issue: ISSUE, origin: "fix-gap" };
    const settled = settleFindingOrigins(verdictOf(unanchored), {
      lineage: lineageOf({ lineage: [] }),
      ownThreadKeys: noOwnThreads,
    });

    expect(only(settled).origin).toBe("pr");
  });

  test("AC-7 reads every fix-gap claim as pr when the PR has no push ledger", () => {
    const second: PrFinding = { ...fixGap, issue: "Unlocked read", line: LINE + 1 };
    const settled = settleFindingOrigins(verdictOf(fixGap, second), noFacts);

    expect(settled.findings.map(({ origin }) => origin)).toEqual(["pr", "pr"]);
  });

  test("AC-8 keeps a fix-regression claim no lineage backs", () => {
    const regression: PrFinding = { ...fixGap, origin: "fix-regression" };
    const settled = settleFindingOrigins(verdictOf(regression), {
      lineage: lineageOf({ lineage: [] }),
      ownThreadKeys: noOwnThreads,
    });

    expect(only(settled).origin).toBe("fix-regression");
  });

  test("AC-9 leaves a finding with no origin carrying none", () => {
    const plain: PrFinding = { kind: "quality", severity: "important", issue: ISSUE, file: FILE, line: LINE };
    const settled = settleFindingOrigins(verdictOf(plain), noFacts);

    expect(only(settled)).not.toHaveProperty("origin");
  });

  test("AC-10 never mutates the verdict it was given", () => {
    const given = verdictOf(fixGap);

    const settled = settleFindingOrigins(given, {
      lineage: lineageOf({ lineage: [] }),
      ownThreadKeys: noOwnThreads,
    });

    expect(settled).not.toBe(given);
    expect(given.findings[0]?.origin).toBe("fix-gap");
    expect(given.findings[0]?.originEvidence).toBe(EVIDENCE);
  });

  test("AC-19 reads a fix-gap claim with a file but no line as pr", () => {
    const anchorless: PrFinding = {
      kind: "quality",
      severity: "important",
      issue: ISSUE,
      file: FILE,
      origin: "fix-gap",
    };
    const settled = settleFindingOrigins(verdictOf(anchorless), {
      lineage: lineageOf({ lineage: [] }),
      ownThreadKeys: noOwnThreads,
    });

    expect(only(settled).origin).toBe("pr");
  });
});

/** Reading the debug line AC-11 asserts needs a logger that writes to a file: level gates the console only. */
describe("settleFindingOrigins logging", () => {
  let dir: string;
  let logFile: string;

  beforeEach(() => {
    dir = makeTempDir("nax-finding-origin-");
    logFile = join(dir, "bot.jsonl");
    initLogger({ level: "silent", filePath: logFile });
  });

  afterEach(() => {
    resetLogger();
    cleanupTempDir(dir);
  });

  async function logged(): Promise<{ level: string; stage: string; message: string; data?: { key?: string } }[]> {
    await getLogger().flush();
    // A logger that wrote nothing never creates its file; that is the empty case, not an error.
    if (!(await Bun.file(logFile).exists())) return [];
    const text = await Bun.file(logFile).text();
    return text
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as { level: string; stage: string; message: string; data?: { key?: string } });
  }

  test("AC-11 logs one debug line naming the key it reads a fix-gap claim as pr", async () => {
    settleFindingOrigins(verdictOf(fixGap), { lineage: lineageOf({ lineage: [] }), ownThreadKeys: noOwnThreads });

    const named = (await logged()).filter((entry) => entry.level === "debug" && entry.data?.key === KEY);

    expect(named).toHaveLength(1);
  });

  test("logs nothing when no claim is read back", async () => {
    settleFindingOrigins(verdictOf(fixGap), { lineage: lineageOf({ lineage: [KEY] }), ownThreadKeys: noOwnThreads });

    expect(await logged()).toEqual([]);
  });
});
