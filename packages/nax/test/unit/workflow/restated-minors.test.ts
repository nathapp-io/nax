import { describe, expect, test } from "bun:test";
import { splitRestatedMinors } from "@/workflow/restated-minors";
import type { MinorItem, WorkflowFindingDraft } from "@/workflow/types";

const minor = (issue: string): WorkflowFindingDraft => ({ kind: "quality", severity: "minor", issue });

// nax numbers deferred minors M1..Mn in order, so a reviewer numbering its own minors collides with them.
const KNOWN: MinorItem[] = [
  {
    id: "M1",
    storyId: "US-001",
    text: "The auth-stamped entry shares one key namespace with a cooldownScope slot",
    triage: "fix-now",
  },
  {
    id: "M2",
    storyId: "US-002",
    text: "lexical() rebuilds the FTS index on any fullTextQuery failure, not just the dropped-index error",
    triage: "fix-now",
  },
  { id: "M3", storyId: "US-003", text: "the two new members carry no doc comment", triage: "leave" },
];

describe("splitRestatedMinors", () => {
  test("an id lead that repeats the known minor's wording is a restatement", () => {
    const out = splitRestatedMinors(
      [minor("M2: every lexical-query failure triggers an exclusive index rebuild")],
      KNOWN,
    );
    expect(out.kept).toEqual([]);
    expect(out.dropped).toEqual([
      { id: "M2", issue: "M2: every lexical-query failure triggers an exclusive index rebuild" },
    ]);
  });

  test("an explicit DEFERRED lead is a restatement whatever the wording", () => {
    const out = splitRestatedMinors([minor("DEFERRED M1, confirmed by probe: state is lost on relogin")], KNOWN);
    expect(out.dropped.map((d) => d.id)).toEqual(["M1"]);
  });

  test("the reviewer's own numbering on unrelated text is a new minor, even when the id is known", () => {
    const fresh = minor("M1: new unrelated nit in foo.ts about a misspelt variable");
    const out = splitRestatedMinors([fresh], KNOWN);
    expect(out.kept).toEqual([fresh]);
    expect(out.dropped).toEqual([]);
  });

  test("an id nax never assigned, or no id at all, is kept", () => {
    const drafts = [minor("M9: the parser leaks a handle"), minor("providerSlotKey hard-codes the literal")];
    expect(splitRestatedMinors(drafts, KNOWN).kept).toEqual(drafts);
  });

  test("only the minors passed in count: a leave minor the re-reviewer never saw is not matched", () => {
    const seen = KNOWN.filter((m) => m.triage === "fix-now");
    const out = splitRestatedMinors([minor("M3: the two new members carry no doc comment")], seen);
    expect(out.dropped).toEqual([]);
  });

  test("blocking findings pass through untouched", () => {
    const blocking: WorkflowFindingDraft = {
      kind: "quality",
      severity: "important",
      issue: "M2: lexical rebuilds the index",
    };
    expect(splitRestatedMinors([blocking], KNOWN).kept).toEqual([blocking]);
  });
});
