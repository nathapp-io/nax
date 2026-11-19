/**
 * US-008: the fix summary's convergence facts — the push count and the chain notice.
 *
 * The count is read from the ledger the summary itself carries; the chain is read from the review's
 * agreed items and the ledger's own issues for their parents. Both are facts, so these tests pin the
 * exact wording a reader of the public comment sees.
 */
import { describe, expect, test } from "bun:test";
import { type AgreedItem, type BotPushEntry, convergenceLines } from "@/bot";
import type { FindingTrigger } from "@/workflow/blocking-findings";

const S = "abcdef1234567890abcdef1234567890abcdef12";
const S7 = "abcdef1";
const BASE = "0000000000000000000000000000000000000000";
const DEFAULT_BLOCKING: readonly FindingTrigger[] = ["normal", "own-concurrency"];
const HEADING = "### Findings are chasing their own fixes";

const entry = (overrides: Partial<BotPushEntry> = {}): BotPushEntry => ({
  base: BASE,
  sha: S,
  at: "2026-11-20T09:00:00Z",
  items: [{ key: "f-a", generation: 1, issue: "lock leaks" }],
  ...overrides,
});

const finding = (overrides: Partial<Extract<AgreedItem, { kind: "finding" }>> = {}): AgreedItem => ({
  kind: "finding",
  key: "f-x",
  issue: "lock leaks again",
  severity: "important",
  trigger: "normal",
  ...overrides,
});

describe("convergenceLines push count", () => {
  test("AC-16 counts three recorded pushes", () => {
    const lines = convergenceLines({
      entries: [entry(), entry(), entry()],
      unreachable: 0,
      agreed: [],
      blocking: DEFAULT_BLOCKING,
      noticeGeneration: 2,
    });
    expect(lines).toEqual(["nax bot fix pushes on this PR: 3"]);
  });

  test("AC-17 names the pushes this PR's history no longer reaches", () => {
    const lines = convergenceLines({
      entries: [entry(), entry(), entry()],
      unreachable: 1,
      agreed: [],
      blocking: DEFAULT_BLOCKING,
      noticeGeneration: 2,
    });
    expect(lines).toEqual(["nax bot fix pushes on this PR: 3 (1 no longer in history)"]);
  });

  test("AC-18 says nothing about pushes when the ledger holds none", () => {
    const lines = convergenceLines({
      entries: [],
      unreachable: 0,
      agreed: [],
      blocking: DEFAULT_BLOCKING,
      noticeGeneration: 2,
    });
    expect(lines).toEqual([]);
    expect(lines.join("\n")).not.toContain("nax bot fix pushes");
  });
});

describe("convergenceLines chain notice", () => {
  test("AC-19 names a blocking finding at the notice generation and the fix it sits on", () => {
    const lines = convergenceLines({
      entries: [
        entry(),
        entry({ sha: `${"b".repeat(40)}`, items: [{ key: "f-a", generation: 1, issue: "lock leaks" }] }),
      ],
      unreachable: 0,
      agreed: [finding({ lineage: { generation: 2, parents: ["f-a"], pushSha: S } })],
      blocking: DEFAULT_BLOCKING,
      noticeGeneration: 2,
    });
    expect(lines).toContain(HEADING);
    expect(lines).toContain(
      `- f-x (Important, normal), generation 2: on lines added by nax bot fix ${S7} for f-a (lock leaks)`,
    );
  });

  test("AC-20 says nothing at generation 1 under a notice generation of 2", () => {
    const lines = convergenceLines({
      entries: [entry()],
      unreachable: 0,
      agreed: [finding({ lineage: { generation: 1, parents: ["f-a"], pushSha: S } })],
      blocking: DEFAULT_BLOCKING,
      noticeGeneration: 2,
    });
    expect(lines).not.toContain(HEADING);
    expect(lines.join("\n")).not.toContain("generation 1");
  });

  test("AC-21 says nothing about a generation-3 finding outside the blocking set", () => {
    const lines = convergenceLines({
      entries: [entry()],
      unreachable: 0,
      agreed: [finding({ trigger: "adversarial", lineage: { generation: 3, parents: ["f-a"], pushSha: S } })],
      blocking: DEFAULT_BLOCKING,
      noticeGeneration: 2,
    });
    expect(lines).not.toContain(HEADING);
    expect(lines.join("\n")).not.toContain("f-x");
    // The push count is still reported: it is a fact about the PR, not about this finding.
    expect(lines).toEqual([`nax bot fix pushes on this PR: 1`]);
  });

  test("a finding under a widened blocking set is named", () => {
    const lines = convergenceLines({
      entries: [entry()],
      unreachable: 0,
      agreed: [finding({ trigger: "adversarial", lineage: { generation: 3, parents: ["f-a"], pushSha: S } })],
      blocking: ["normal", "adversarial"],
      noticeGeneration: 2,
    });
    expect(lines).toContain(HEADING);
  });

  test("a finding with no lineage is never named", () => {
    const lines = convergenceLines({
      entries: [entry()],
      unreachable: 0,
      agreed: [finding()],
      blocking: DEFAULT_BLOCKING,
      noticeGeneration: 1,
    });
    expect(lines).not.toContain(HEADING);
  });

  test("a thread or comment item is never named", () => {
    const lines = convergenceLines({
      entries: [entry()],
      unreachable: 0,
      agreed: [{ kind: "thread", key: "t-1", issue: "rename", reason: "clearer", threadId: "n1", replyTo: "9" }],
      blocking: DEFAULT_BLOCKING,
      noticeGeneration: 1,
    });
    expect(lines).not.toContain(HEADING);
  });

  test("names every parent, and one the ledger lost without an issue", () => {
    const lines = convergenceLines({
      entries: [
        entry({
          items: [
            { key: "f-a", generation: 1, issue: "lock leaks" },
            { key: "f-b", generation: 2, issue: "retry loop" },
          ],
        }),
      ],
      unreachable: 0,
      agreed: [
        finding({
          key: "f-y",
          severity: "critical",
          trigger: "own-concurrency",
          lineage: { generation: 4, parents: ["f-a", "f-b", "f-gone"], pushSha: S },
        }),
      ],
      blocking: DEFAULT_BLOCKING,
      noticeGeneration: 2,
    });
    expect(lines).toContain(
      `- f-y (Critical, own-concurrency), generation 4: on lines added by nax bot fix ${S7} for f-a (lock leaks), f-b (retry loop), f-gone`,
    );
  });
});
