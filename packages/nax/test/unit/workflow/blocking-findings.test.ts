import { describe, expect, test } from "bun:test";
import type { PrComment, PrCommentKind } from "@/forge";
import type { WorkflowSeverity } from "@/operations";
import type { FindingOrigin, FindingTrigger } from "@/workflow/blocking-findings";
import {
  configuredBlockingTriggers,
  configuredChainNoticeGeneration,
  DEFAULT_BLOCKING_TRIGGERS,
  DEFAULT_CHAIN_NOTICE_GENERATION,
  effectiveBlockingTriggers,
  FINDING_ORIGINS,
  FINDING_TRIGGERS,
  firstIssueLine,
  isBlockingFinding,
  parseFindingOrigin,
  parseFindingTrigger,
  readFindingThreadFacts,
} from "@/workflow/blocking-findings";

interface CommentInput {
  readonly id: string;
  readonly body: string;
  readonly author?: string;
  readonly createdAt?: string;
  readonly kind?: PrCommentKind;
}

/** A top-level PR comment by a writer unless a case says otherwise. */
function comment(input: CommentInput): PrComment {
  return {
    id: input.id,
    kind: input.kind ?? "comment",
    author: input.author ?? "writer",
    body: input.body,
    createdAt: input.createdAt ?? "2026-01-01T00:00:00.000Z",
  };
}

const WRITERS: ReadonlySet<string> = new Set(["writer"]);

/** The configured set every case starts from; narrower than the default so "config" is distinguishable. */
const CONFIGURED: readonly FindingTrigger[] = ["normal"];

function effective(comments: readonly PrComment[], configured: readonly FindingTrigger[] = CONFIGURED) {
  return effectiveBlockingTriggers({ comments, writers: WRITERS, configured });
}

describe("parseFindingTrigger", () => {
  test.each([...FINDING_TRIGGERS])("US-001 AC-1 returns %s unchanged", (trigger) => {
    const parsed: FindingTrigger = parseFindingTrigger(trigger);
    expect(parsed).toBe(trigger);
  });
  test.each([
    ["an absent trigger", undefined],
    ["an unknown class", "race"],
    ["a number", 3],
  ])("US-001 AC-2 reads %s as normal", (_case, value) => {
    expect(parseFindingTrigger(value)).toBe("normal");
  });
});

describe("FINDING_ORIGINS", () => {
  test("US-001 AC-1 lists the three origins in order", () => {
    expect(FINDING_ORIGINS).toEqual(["pr", "fix-regression", "fix-gap"]);
  });
});

describe("parseFindingOrigin", () => {
  test.each([...FINDING_ORIGINS])("returns %s unchanged", (origin) => {
    const parsed: FindingOrigin | undefined = parseFindingOrigin(origin);
    expect(parsed).toBe(origin);
  });
  test("US-001 AC-2 returns fix-gap for a fix-gap claim", () => {
    expect(parseFindingOrigin("fix-gap")).toBe("fix-gap");
  });
  test("US-001 AC-3 returns undefined for an absent origin", () => {
    expect(parseFindingOrigin(undefined)).toBeUndefined();
  });
  test("US-001 AC-4 returns undefined for an unknown origin", () => {
    expect(parseFindingOrigin("regression")).toBeUndefined();
  });
});

describe("DEFAULT_BLOCKING_TRIGGERS", () => {
  test("US-002 AC-1 holds normal and own-concurrency", () => {
    expect(DEFAULT_BLOCKING_TRIGGERS).toEqual(["normal", "own-concurrency"]);
  });
  test("US-002 AC-1 notices have a default generation of 2", () => {
    expect(DEFAULT_CHAIN_NOTICE_GENERATION).toBe(2);
  });
});

describe("isBlockingFinding", () => {
  test("US-002 AC-6 blocks an important finding whose trigger is in the set", () => {
    expect(isBlockingFinding({ severity: "important", trigger: "normal" }, ["normal"])).toBe(true);
  });
  test("US-002 AC-7 does not block a minor finding", () => {
    expect(isBlockingFinding({ severity: "minor", trigger: "normal" }, ["normal"])).toBe(false);
  });
  test("US-002 AC-8 does not block a critical finding whose trigger is outside the set", () => {
    expect(isBlockingFinding({ severity: "critical", trigger: "adversarial" }, ["normal", "own-concurrency"])).toBe(
      false,
    );
  });
  test("US-002 AC-9 reads an absent trigger as normal", () => {
    expect(isBlockingFinding({ severity: "important" }, ["normal"])).toBe(true);
  });
  test("does not block an absent trigger when normal is not in the set", () => {
    expect(isBlockingFinding({ severity: "critical" }, ["manual"])).toBe(false);
  });
  test("US-001 AC-5 does not block an important normal fix-gap finding", () => {
    expect(
      isBlockingFinding({ severity: "important", trigger: "normal", origin: "fix-gap" }, ["normal", "own-concurrency"]),
    ).toBe(false);
  });
  test("US-001 AC-6 blocks an important normal fix-regression finding", () => {
    expect(
      isBlockingFinding({ severity: "important", trigger: "normal", origin: "fix-regression" }, [
        "normal",
        "own-concurrency",
      ]),
    ).toBe(true);
  });
  test("US-001 AC-7 blocks an important normal finding with no origin", () => {
    expect(isBlockingFinding({ severity: "important", trigger: "normal" }, ["normal", "own-concurrency"])).toBe(true);
  });
  test("US-001 AC-8 does not block a minor fix-regression finding", () => {
    expect(
      isBlockingFinding({ severity: "minor", trigger: "normal", origin: "fix-regression" }, [
        "normal",
        "own-concurrency",
      ]),
    ).toBe(false);
  });
  test("US-001 AC-9 does not block an important adversarial pr finding", () => {
    expect(
      isBlockingFinding({ severity: "important", trigger: "adversarial", origin: "pr" }, ["normal", "own-concurrency"]),
    ).toBe(false);
  });
});

describe("readFindingThreadFacts", () => {
  test("US-002 AC-10 reads the severity label and the trigger line", () => {
    const body = "**Critical** (quality): x\n\nTrigger: adversarial - y";
    expect(readFindingThreadFacts(body)).toEqual({ severity: "critical", trigger: "adversarial", origin: "pr" });
  });
  test("US-002 AC-11 reads an unlabelled body as important with a normal trigger", () => {
    expect(readFindingThreadFacts("the lock is not released when the claim file is stale")).toEqual({
      severity: "important",
      trigger: "normal",
      origin: "pr",
    });
  });
  test("US-001 AC-10 reads the origin line beside the severity and the trigger", () => {
    const body =
      "**Important** (quality): Lock leaks\n\nTrigger: normal - two writers\nOrigin: fix-gap - added by push 1";
    expect(readFindingThreadFacts(body)).toEqual({ severity: "important", trigger: "normal", origin: "fix-gap" });
  });
  test("US-001 AC-11 reads a body with no origin line as pr", () => {
    expect(readFindingThreadFacts("**Important** (quality): Lock leaks\n\nTrigger: normal").origin).toBe("pr");
  });
  test("US-001 AC-12 reads an unknown origin as pr", () => {
    expect(readFindingThreadFacts("**Important** (quality): Lock leaks\n\nOrigin: later - x").origin).toBe("pr");
  });
  test.each<[string, WorkflowSeverity]>([
    ["**Critical** (quality): x", "critical"],
    ["**Important** (quality): x", "important"],
    ["**Minor** (quality): x", "minor"],
  ])("reads %p as %s", (body, severity) => {
    expect(readFindingThreadFacts(body).severity).toBe(severity);
  });
  test("reads an unknown trigger class as normal", () => {
    expect(readFindingThreadFacts("**Minor** (x): y\n\nTrigger: race - z").trigger).toBe("normal");
  });
});

describe("firstIssueLine", () => {
  test("US-002 AC-12 drops the severity label and the metadata lines", () => {
    const issue = [
      "**Important** (quality): lock leaks",
      "more",
      "",
      "Trigger: normal",
      "Lineage: generation 1, on lines added by nax bot fix abc1234 for f-a",
    ].join("\n");
    expect(firstIssueLine(issue)).toBe("lock leaks");
  });
  test("US-002 AC-13 returns a plain issue unchanged", () => {
    expect(firstIssueLine("plain issue")).toBe("plain issue");
  });
  test("US-001 AC-13 drops an origin line", () => {
    expect(firstIssueLine("Origin: fix-gap - x\nLock leaks")).toBe("Lock leaks");
  });
  test("returns the first non-empty line when the issue opens with a blank line", () => {
    expect(firstIssueLine("\n\n  second line  \n")).toBe("second line");
  });
});

describe("effectiveBlockingTriggers", () => {
  test("US-002 AC-14 keeps the configured set when no scope comment exists", () => {
    expect(effective([])).toEqual({ triggers: ["normal"], source: "config", invalid: [] });
  });
  test("US-002 AC-15 names the writer comment that ruled the scope", () => {
    const ruling = comment({ id: "c1", body: "Blocking Triggers: normal" });
    expect(effective([ruling])).toEqual({
      triggers: ["normal"],
      source: { commentId: "c1", author: "writer" },
      invalid: [],
    });
  });
  test("US-002 AC-16 ignores a matching first line from an author without write access", () => {
    const ruling = comment({ id: "c1", author: "stranger", body: "blocking triggers: manual" });
    expect(effective([ruling])).toEqual({ triggers: ["normal"], source: "config", invalid: [] });
  });
  test("US-002 AC-17 ignores a quoted first line", () => {
    const ruling = comment({ id: "c1", body: "> blocking triggers: manual" });
    expect(effective([ruling])).toEqual({ triggers: ["normal"], source: "config", invalid: [] });
  });
  test("US-002 AC-18 lets the newest writer scope comment win", () => {
    const older = comment({ id: "c1", createdAt: "2026-01-01T00:00:00.000Z", body: "blocking triggers: manual" });
    const newer = comment({ id: "c2", createdAt: "2026-02-01T00:00:00.000Z", body: "blocking triggers: adversarial" });
    expect(effective([older, newer])).toEqual({
      triggers: ["adversarial"],
      source: { commentId: "c2", author: "writer" },
      invalid: [],
    });
  });
  test("US-002 AC-19 reports an unknown class as an invalid ruling", () => {
    const ruling = comment({ id: "c1", body: "blocking triggers: normal, race" });
    expect(effective([ruling])).toEqual({
      triggers: ["normal"],
      source: "config",
      invalid: ["blocking triggers: normal, race"],
    });
  });
  test("US-002 AC-20 reports an empty list as an invalid ruling", () => {
    const ruling = comment({ id: "c1", body: "blocking triggers:" });
    expect(effective([ruling])).toEqual({
      triggers: ["normal"],
      source: "config",
      invalid: ["blocking triggers:"],
    });
  });
  test("accepts a multi-class ruling narrower or wider than config", () => {
    const ruling = comment({ id: "c1", body: "blocking triggers: Normal, adversarial" });
    expect(effective([ruling]).triggers).toEqual(["normal", "adversarial"]);
  });
  test("ignores a scope-shaped first line inside a review or an inline thread", () => {
    const review = comment({ id: "c1", kind: "review", body: "blocking triggers: manual" });
    const thread = comment({ id: "c2", kind: "thread", body: "blocking triggers: manual" });
    expect(effective([review, thread])).toEqual({ triggers: ["normal"], source: "config", invalid: [] });
  });
  test("keeps a valid ruling when an older invalid one also exists", () => {
    const invalid = comment({ id: "c1", createdAt: "2026-01-01T00:00:00.000Z", body: "blocking triggers: race" });
    const valid = comment({ id: "c2", createdAt: "2026-02-01T00:00:00.000Z", body: "blocking triggers: manual" });
    expect(effective([invalid, valid])).toEqual({
      triggers: ["manual"],
      source: { commentId: "c2", author: "writer" },
      invalid: ["blocking triggers: race"],
    });
  });
  test("orders unparseable timestamps by their text", () => {
    const older = comment({ id: "c1", createdAt: "aaa", body: "blocking triggers: manual" });
    const newer = comment({ id: "c2", createdAt: "bbb", body: "blocking triggers: adversarial" });
    expect(effective([older, newer]).source).toEqual({ commentId: "c2", author: "writer" });
  });
});

describe("configuredBlockingTriggers", () => {
  test("US-003 AC-21 returns DEFAULT_BLOCKING_TRIGGERS for a config with no bot section at all", () => {
    expect(configuredBlockingTriggers({})).toEqual(DEFAULT_BLOCKING_TRIGGERS);
  });
  test("US-002: reads the default when the key is absent", () => {
    expect(configuredBlockingTriggers({ bot: {} })).toEqual(["normal", "own-concurrency"]);
  });
  test("US-002: reads a configured set", () => {
    expect(configuredBlockingTriggers({ bot: { blockingTriggers: ["manual"] } })).toEqual(["manual"]);
  });
  test("US-002: falls back to the default for an empty set from an unvalidated config", () => {
    expect(configuredBlockingTriggers({ bot: { blockingTriggers: [] } })).toEqual(["normal", "own-concurrency"]);
  });
});

describe("configuredChainNoticeGeneration", () => {
  test("US-003 AC-21 reads the defaults for a config with no bot section at all", () => {
    expect(configuredChainNoticeGeneration({})).toBe(DEFAULT_CHAIN_NOTICE_GENERATION);
  });
  test("US-002: reads the default when the key is absent", () => {
    expect(configuredChainNoticeGeneration({ bot: {} })).toBe(2);
  });
  test("US-002: reads a configured generation", () => {
    expect(configuredChainNoticeGeneration({ bot: { chainNoticeGeneration: 4 } })).toBe(4);
  });
});
