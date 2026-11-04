/**
 * koda-mapping.ts — pure reconciliation of one koda export page into mirror
 * notes and decisions.
 *
 * Covers US-003 AC-1..AC-23.
 */

import { describe, expect, test } from "bun:test";
import type { MemoryDecision } from "@nathapp/nax-agent";
import { NaxError } from "@/errors";
import {
  KODA_NOTE_TYPES,
  type KodaMemoryItem,
  MEMORY_KODA_DECISIONS_MAX,
  mergeKodaDecisions,
  parseKodaItems,
  reconcileKodaNotes,
} from "@/memory/koda-mapping";

/** One koda export row, with the fields a test cares about overridden. */
function row(over: Partial<KodaMemoryItem> = {}): KodaMemoryItem {
  return {
    id: "k1",
    kind: "NOTE",
    scope: "project",
    subject: "replay-budget",
    predicate: "project",
    object: "Budget 2,048 MiB.",
    description: "replay budget",
    status: "active",
    updatedAt: "2026-11-04T01:00:00.000Z",
    sourceType: "nax-chat",
    ...over,
  };
}

/** One koda DECISION row. */
function decisionRow(over: Partial<KodaMemoryItem> = {}): KodaMemoryItem {
  return row({
    kind: "DECISION",
    id: "d2",
    object: "merge after the suite",
    description: "merge order",
    updatedAt: "2026-11-05T01:00:00.000Z",
    ...over,
  });
}

/** One decision already in the mirror. */
function currentDecision(over: Partial<MemoryDecision> = {}): MemoryDecision {
  return {
    id: "d1",
    subject: "replay-budget",
    predicate: "decision",
    object: "budget is 2048 MiB",
    updatedAt: "2026-11-01T00:00:00.000Z",
    status: "active",
    ...over,
  };
}

/** An ISO timestamp `step` days after a fixed epoch, so a test can order decisions. */
function isoDay(step: number): string {
  return new Date(Date.UTC(2026, 0, 1) + step * 86_400_000).toISOString();
}

/** The statuses a mirror line may carry (nax-agent's `MEMORY_DECISION_STATUSES`). */
const DECISION_STATUSES = ["active", "superseded", "rejected"] as const;

/**
 * The mirror's decision contract, restated: `DecisionSchema` in nax-agent's
 * `memory/records.ts` requires six non-empty strings and a status in range. A line that
 * fails it is dropped when the mirror decodes `decisions.jsonl`, so writing one loses the
 * decision it replaced.
 */
function isStorableDecision(decision: MemoryDecision): boolean {
  const fields = [decision.id, decision.subject, decision.predicate, decision.object, decision.updatedAt];
  return fields.every((field) => field.length > 0) && DECISION_STATUSES.some((status) => status === decision.status);
}

/** The NaxError `run` throws; fails the test when it returns instead. */
function thrownBy(run: () => unknown): NaxError {
  try {
    run();
  } catch (error) {
    if (error instanceof NaxError) return error;
    throw new Error(`expected a NaxError, got ${String(error)}`);
  }
  throw new Error("expected a NaxError, got no throw");
}

describe("KODA_NOTE_TYPES", () => {
  test("names the four note types koda's predicate carries", () => {
    expect(KODA_NOTE_TYPES).toEqual(["user", "feedback", "project", "reference"]);
  });
});

describe("reconcileKodaNotes", () => {
  test("maps one active NOTE row to its note (AC-1)", () => {
    expect(reconcileKodaNotes([row()], "project", new Map())).toEqual({
      notes: [
        {
          id: "k1",
          slug: "replay-budget",
          type: "project",
          scope: "project",
          description: "replay budget",
          body: "Budget 2,048 MiB.",
          updatedAt: "2026-11-04T01:00:00.000Z",
          source: "nax-chat",
          status: "active",
        },
      ],
      skipped: 0,
    });
  });

  test("does not take a user-scope row on a project page (AC-2)", () => {
    expect(reconcileKodaNotes([row({ scope: "user" })], "project", new Map())).toEqual({
      notes: [],
      skipped: 0,
    });
  });

  test("skips a row whose predicate is not a note type (AC-3)", () => {
    expect(reconcileKodaNotes([row({ predicate: "fact" })], "project", new Map())).toEqual({
      notes: [],
      skipped: 1,
    });
  });

  test("skips a row whose subject is not a note slug (AC-4)", () => {
    expect(reconcileKodaNotes([row({ subject: "Bad Slug" })], "project", new Map())).toEqual({
      notes: [],
      skipped: 1,
    });
  });

  test("skips a row with no description (AC-5)", () => {
    expect(reconcileKodaNotes([row({ description: undefined })], "project", new Map())).toEqual({
      notes: [],
      skipped: 1,
    });
  });

  test("yields no note for a superseded row that supersedes the mirror's note (AC-6)", () => {
    const mirrorIds = new Map([["replay-budget", "k1"]]);
    expect(reconcileKodaNotes([row({ status: "superseded" })], "project", mirrorIds)).toEqual({
      notes: [],
      skipped: 0,
    });
  });

  test("takes the active successor of a superseded row (AC-7)", () => {
    const mirrorIds = new Map([["replay-budget", "k1"]]);
    const result = reconcileKodaNotes(
      [row({ status: "superseded" }), row({ id: "k2", object: "Budget 4,096 MiB." })],
      "project",
      mirrorIds,
    );
    expect(result.notes.map((note) => [note.id, note.status])).toEqual([["k2", "active"]]);
    expect(result.skipped).toBe(0);
  });

  test("ignores a stale tombstone that names an older id (AC-8)", () => {
    const result = reconcileKodaNotes([row({ id: "k2" }), row({ id: "k1", status: "rejected" })], "project", new Map());
    expect(result.notes.map((note) => [note.id, note.status])).toEqual([["k2", "active"]]);
  });

  test("applies a tombstone to the id a superseded row left unknown (AC-9)", () => {
    const mirrorIds = new Map([["replay-budget", "k1"]]);
    const result = reconcileKodaNotes(
      [row({ status: "superseded" }), row({ id: "k2", deletedAt: "2026-11-05T00:00:00.000Z" })],
      "project",
      mirrorIds,
    );
    expect(result.notes.map((note) => [note.id, note.status])).toEqual([["k2", "deleted"]]);
  });

  test("keeps a rejection of the mirror's own note (AC-10)", () => {
    const mirrorIds = new Map([["replay-budget", "k1"]]);
    const result = reconcileKodaNotes([row({ status: "rejected" })], "project", mirrorIds);
    expect(result.notes.map((note) => [note.id, note.status])).toEqual([["k1", "rejected"]]);
  });

  test("reads an active row carrying deletedAt as a deletion (AC-11)", () => {
    const mirrorIds = new Map([["replay-budget", "k1"]]);
    const result = reconcileKodaNotes(
      [row({ status: "active", deletedAt: "2026-11-05T00:00:00.000Z" })],
      "project",
      mirrorIds,
    );
    expect(result.notes.map((note) => [note.id, note.status])).toEqual([["k1", "deleted"]]);
  });

  test("ignores a tombstone that does not name the mirror's id (AC-12)", () => {
    const mirrorIds = new Map([["replay-budget", "k9"]]);
    expect(reconcileKodaNotes([row({ status: "rejected" })], "project", mirrorIds)).toEqual({
      notes: [],
      skipped: 0,
    });
  });

  test("ignores a tombstone for a slug the mirror does not hold (AC-13)", () => {
    expect(reconcileKodaNotes([row({ status: "rejected" })], "project", new Map())).toEqual({
      notes: [],
      skipped: 0,
    });
  });

  test("orders the notes by slug code point (AC-14)", () => {
    const result = reconcileKodaNotes(
      [row({ id: "k1", subject: "b-note" }), row({ id: "k2", subject: "a-note" })],
      "project",
      new Map(),
    );
    expect(result.notes.map((note) => note.slug)).toEqual(["a-note", "b-note"]);
  });

  test("falls back to the koda source when sourceType is absent (AC-15)", () => {
    const result = reconcileKodaNotes([row({ sourceType: undefined })], "project", new Map());
    expect(result.notes[0]?.source).toBe("koda");
  });

  test("collapses whitespace in sourceType (AC-16)", () => {
    const result = reconcileKodaNotes([row({ sourceType: "nax  run\n x" })], "project", new Map());
    expect(result.notes[0]?.source).toBe("nax run x");
  });

  test("reads a sourceType that is not a string as absent (F1)", () => {
    // A row reaches the mapping through parseKodaItems, which checks the container only,
    // so a non-string sourceType is a shape this page must still reconcile.
    const items = parseKodaItems([{ ...row(), sourceType: 42 }]);
    const result = reconcileKodaNotes(items, "project", new Map());
    expect(result.notes.map((note) => [note.id, note.source])).toEqual([["k1", "koda"]]);
  });

  test("is not a note of the page: a DECISION row yields no note", () => {
    expect(reconcileKodaNotes([decisionRow()], "project", new Map())).toEqual({ notes: [], skipped: 0 });
  });

  test("drops a page note the next row supersedes (R3)", () => {
    const result = reconcileKodaNotes(
      [row({ id: "k1" }), row({ id: "k1", status: "superseded" })],
      "project",
      new Map(),
    );
    expect(result.notes).toEqual([]);
  });

  test("ignores a row whose status is none of active, superseded or rejected", () => {
    expect(reconcileKodaNotes([row({ status: "pending" })], "project", new Map())).toEqual({
      notes: [],
      skipped: 0,
    });
  });

  test("takes every row of a page into one note per slug", () => {
    const result = reconcileKodaNotes(
      [
        row({ id: "k1", subject: "a-note" }),
        row({ id: "k2", subject: "b-note" }),
        row({ id: "k3", subject: "a-note", object: "Budget 8,192 MiB." }),
      ],
      "project",
      new Map(),
    );
    expect(result.notes.map((note) => [note.slug, note.id, note.body])).toEqual([
      ["a-note", "k3", "Budget 8,192 MiB."],
      ["b-note", "k2", "Budget 2,048 MiB."],
    ]);
  });
});

describe("mergeKodaDecisions", () => {
  test("answers decisions undefined when the page carries no DECISION row (AC-17)", () => {
    expect(mergeKodaDecisions([currentDecision()], [row()])).toEqual({ decisions: undefined, skipped: 0 });
  });

  test("merges a newer active decision ahead of the current ones (AC-18)", () => {
    const result = mergeKodaDecisions([currentDecision()], [decisionRow({ id: "d2" })]);
    expect(result.decisions?.map((decision) => decision.id)).toEqual(["d2", "d1"]);
    expect(result.decisions?.[0]).toEqual({
      id: "d2",
      subject: "replay-budget",
      predicate: "project",
      object: "merge after the suite",
      updatedAt: "2026-11-05T01:00:00.000Z",
      status: "active",
    });
    expect(result.skipped).toBe(0);
  });

  test("removes the id a superseded decision names (AC-19)", () => {
    const result = mergeKodaDecisions([currentDecision()], [decisionRow({ id: "d1", status: "superseded" })]);
    expect(result.decisions).toEqual([]);
  });

  test("removes the id an active decision carrying deletedAt names (AC-20)", () => {
    const result = mergeKodaDecisions(
      [currentDecision()],
      [decisionRow({ id: "d1", status: "active", deletedAt: "2026-11-05T00:00:00.000Z" })],
    );
    expect(result.decisions).toEqual([]);
  });

  test("answers decisions undefined and counts a decision row with no object (AC-21)", () => {
    expect(mergeKodaDecisions([], [decisionRow({ object: undefined })])).toEqual({
      decisions: undefined,
      skipped: 1,
    });
  });

  test("cuts the merged list to MEMORY_KODA_DECISIONS_MAX, newest first (AC-22)", () => {
    const rows = Array.from({ length: MEMORY_KODA_DECISIONS_MAX + 1 }, (_unused, index) =>
      decisionRow({ id: `d${index}`, updatedAt: isoDay(index) }),
    );
    const result = mergeKodaDecisions([], rows);
    expect(MEMORY_KODA_DECISIONS_MAX).toBe(500);
    expect(result.decisions).toHaveLength(MEMORY_KODA_DECISIONS_MAX);
    expect(result.decisions?.[0]?.id).toBe(`d${MEMORY_KODA_DECISIONS_MAX}`);
    expect(result.decisions?.[MEMORY_KODA_DECISIONS_MAX - 1]?.id).toBe("d1");
  });

  test("orders decisions sharing one updatedAt by id (R6)", () => {
    const rows = [decisionRow({ id: "d9", updatedAt: isoDay(3) }), decisionRow({ id: "d8", updatedAt: isoDay(3) })];
    expect(mergeKodaDecisions([], rows).decisions?.map((decision) => decision.id)).toEqual(["d8", "d9"]);
  });

  test("ignores rows of other kinds", () => {
    const fact = row({ kind: "FACT", id: "f1" });
    expect(mergeKodaDecisions([], [fact])).toEqual({ decisions: undefined, skipped: 0 });
  });

  test("does not replace a current decision with a row the mirror would refuse (F2)", () => {
    const result = mergeKodaDecisions([currentDecision()], [decisionRow({ id: "d1", object: "" })]);
    expect(result.decisions).toBeUndefined();
    expect(result.skipped).toBe(1);
  });

  test("keeps the current decision while applying the page's other decisions (F2)", () => {
    const current = currentDecision();
    const result = mergeKodaDecisions([current], [decisionRow({ id: "d1", object: "" }), decisionRow({ id: "d2" })]);
    expect(result.decisions?.map((decision) => decision.id)).toEqual(["d2", "d1"]);
    expect(result.decisions?.[1]).toEqual(current);
    expect(result.skipped).toBe(1);
  });

  test("answers only decisions the mirror can store and decode (F2)", () => {
    const rows = [
      decisionRow({ id: "d2" }),
      decisionRow({ id: "d3", subject: "" }),
      decisionRow({ id: "d4", updatedAt: "" }),
      decisionRow({ id: "", object: "no id" }),
    ];
    const result = mergeKodaDecisions([currentDecision()], rows);
    expect(result.decisions?.every(isStorableDecision)).toBe(true);
    expect(result.decisions?.map((decision) => decision.id)).toEqual(["d2", "d1"]);
    expect(result.skipped).toBe(3);
    // The mirror writes one JSON line per decision and decodes it with a schema that
    // requires every field to be a non-empty string, so the round trip has to survive.
    expect(JSON.parse(JSON.stringify(result.decisions))).toEqual(result.decisions);
  });
});

describe("parseKodaItems", () => {
  test("throws MEMORY_KODA_BAD_RESPONSE when the value is not an array (AC-23)", () => {
    const error = thrownBy(() => parseKodaItems({ items: [] }));
    expect(error.code).toBe("MEMORY_KODA_BAD_RESPONSE");
    expect(error.message).toContain("memory");
  });

  test("returns the array's records as they are", () => {
    const items = [row(), decisionRow()];
    expect(parseKodaItems(items)).toEqual(items);
  });

  test("drops an element that is not an object", () => {
    expect(parseKodaItems([row(), "not a row", null])).toEqual([row()]);
  });
});
