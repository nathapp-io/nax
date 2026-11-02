/**
 * Keyword search over the mirror: whole-token, Unicode-aware, deterministic.
 *
 * Both functions are pure — notes in, hits out, no store and no filesystem — so
 * every case here is one array literal and the slugs, scores and snippets it
 * produces. The scoring is pinned because it is what ranks a session's memory:
 * a slug/description match is worth twice a body match, and a query word never
 * matches a longer word (`replay` is not `replays`).
 */
import { describe, expect, test } from "bun:test";
import * as entry from "@nathapp/nax-agent";
import {
  type MemoryHit,
  type MemoryNote,
  type MemoryNoteStatus,
  searchMemoryNotes,
  tokenizeMemoryQuery,
} from "@nathapp/nax-agent";
import { assertDefined } from "#test/helpers/index";

/** One note, with overrides: the shape every search assertion starts from. */
function note(overrides: Partial<MemoryNote> = {}): MemoryNote {
  return {
    id: "mem_01J9X2",
    slug: "replay-budget",
    type: "project",
    scope: "project",
    description: "replay budget stays 2,048 MiB",
    source: "nax-chat",
    updatedAt: "2026-11-02T08:11:00.000Z",
    status: "active",
    body: "The replay budget stays at 2,048 MiB.\n",
    ...overrides,
  };
}

/** Search with the limit every ranking case fits inside. */
function search(notes: readonly MemoryNote[], text: string): readonly MemoryHit[] {
  return searchMemoryNotes(notes, text, 10);
}

/** The hit slugs in the order the search returned them. */
function slugs(hits: readonly MemoryHit[]): readonly string[] {
  return hits.map((hit) => hit.slug);
}

/** The single hit for a one-note array, or a readable failure. */
function onlyHit(hits: readonly MemoryHit[]): MemoryHit {
  expect(hits).toHaveLength(1);
  const hit = hits[0];
  assertDefined(hit, "the single search hit");
  return hit;
}

describe("tokenizeMemoryQuery", () => {
  test("splits on punctuation and lower-cases the tokens (AC-1)", () => {
    expect(tokenizeMemoryQuery("Replay-Budget, 2048 MiB!")).toEqual(["replay", "budget", "2048", "mib"]);
  });

  test("drops tokens shorter than two characters and removes duplicates (AC-2)", () => {
    expect(tokenizeMemoryQuery("a b replay replay")).toEqual(["replay"]);
  });

  test("keeps Unicode letters as token characters (AC-3)", () => {
    expect(tokenizeMemoryQuery("Größe über")).toEqual(["größe", "über"]);
  });

  test("returns no tokens for text with nothing to match", () => {
    expect(tokenizeMemoryQuery("")).toEqual([]);
    expect(tokenizeMemoryQuery(" - , ! ")).toEqual([]);
  });
});

describe("searchMemoryNotes: ranking", () => {
  test("ranks a slug match above a body-only match of the same words (AC-4)", () => {
    const slugMatch = note({ slug: "replay-budget", description: "caps the replay budget", body: "unrelated text\n" });
    const bodyMatch = note({
      slug: "tail-size",
      description: "the tail of the log",
      body: "the replay budget covers the log tail\n",
    });

    const hits = search([bodyMatch, slugMatch], "replay budget");

    expect(slugs(hits)).toEqual(["replay-budget", "tail-size"]);
    expect(hits[0]?.score).toBe(4);
    expect(hits[1]?.score).toBe(2);
  });

  test("scores a body-only match 1 and a description-only match 2 (AC-5)", () => {
    const bodyOnly = note({ slug: "tail-size", description: "the log tail", body: "replay window\n" });
    const descriptionOnly = note({ slug: "log-tail", description: "replay window", body: "unrelated\n" });

    expect(onlyHit(search([bodyOnly], "replay")).score).toBe(1);
    expect(onlyHit(search([descriptionOnly], "replay")).score).toBe(2);
  });

  test("counts a query token repeated in a field once (AC-6)", () => {
    const repeatedInBody = note({ slug: "tail-size", description: "the log tail", body: "replay replay replay\n" });
    const repeatedInDescription = note({ slug: "log-tail", description: "replay replay", body: "unrelated\n" });

    expect(onlyHit(search([repeatedInBody], "replay replay")).score).toBe(1);
    expect(onlyHit(search([repeatedInDescription], "replay replay")).score).toBe(2);
  });

  test("does not match a longer word that starts with the query token (AC-7)", () => {
    const longerWordOnly = note({ slug: "log-tail", description: "the log tail", body: "it replays the log\n" });
    const wholeWord = note({ slug: "replay-log", description: "the log tail", body: "unrelated text\n" });

    expect(search([longerWordOnly], "replay")).toEqual([]);
    expect(slugs(search([longerWordOnly, wholeWord], "replay"))).toEqual(["replay-log"]);
  });

  test("matches case-insensitively (AC-13)", () => {
    const lowerCaseBody = note({
      slug: "log-tail",
      description: "the log tail",
      body: "it replays nothing, replay on\n",
    });

    expect(onlyHit(search([lowerCaseBody], "REPLAY")).score).toBe(1);
  });
});

describe("searchMemoryNotes: which notes are returned", () => {
  test("never returns a superseded, rejected or deleted note (AC-8)", () => {
    const statuses: readonly MemoryNoteStatus[] = ["superseded", "rejected", "deleted"];
    const excluded = statuses.map((status) => note({ slug: `gone-${status}`, status }));

    expect(search(excluded, "replay")).toEqual([]);
  });

  test("returns active and pending notes", () => {
    const notes = [note({ slug: "replay-budget" }), note({ slug: "replay-window", status: "pending" })];

    expect(slugs(search(notes, "replay"))).toEqual(["replay-budget", "replay-window"]);
  });

  test("drops notes that score zero", () => {
    const unrelated = note({ slug: "log-tail", description: "the log tail", body: "unrelated text\n" });

    expect(search([unrelated], "replay")).toEqual([]);
  });
});

describe("searchMemoryNotes: ordering and limit", () => {
  test("orders equal scores by updatedAt descending, then slug ascending (AC-9)", () => {
    const newer = note({ slug: "zeta-window", updatedAt: "2026-11-03T00:00:00.000Z" });
    const olderAlpha = note({ slug: "alpha-window", updatedAt: "2026-11-01T00:00:00.000Z" });
    const olderBeta = note({ slug: "beta-window", updatedAt: "2026-11-01T00:00:00.000Z" });

    expect(slugs(search([olderBeta, newer, olderAlpha], "replay"))).toEqual([
      "zeta-window",
      "alpha-window",
      "beta-window",
    ]);
  });

  test("orders by the instant a timestamp names, not by its literal text (AC-9)", () => {
    // The +09:00 value is 03:00Z, so the Z value six hours later is the newer
    // note — which is the reverse of both the literal string order and slug order.
    const earlierWithOffset = note({ slug: "alpha-window", updatedAt: "2026-11-01T12:00:00.000+09:00" });
    const laterInUtc = note({ slug: "zeta-window", updatedAt: "2026-11-01T06:00:00.000Z" });

    expect(slugs(search([earlierWithOffset, laterInUtc], "replay"))).toEqual(["zeta-window", "alpha-window"]);
  });

  test("falls back to the literal timestamp when a value names no instant (AC-9)", () => {
    // The note codec only requires a non-empty single line, so a value may not
    // parse: the order must stay deterministic instead of throwing or comparing NaN.
    const unparsedLater = note({ slug: "zeta-window", updatedAt: "zeta-marker" });
    const unparsedEarlier = note({ slug: "alpha-window", updatedAt: "alpha-marker" });

    expect(slugs(search([unparsedEarlier, unparsedLater], "replay"))).toEqual(["zeta-window", "alpha-window"]);
  });

  test("puts a note with an unparseable timestamp last, whatever the input order (AC-9)", () => {
    // One total order, so the comparator is transitive: instants first (newest
    // first), then the values that name none. A mixed literal/parsed compare
    // would be non-transitive here — the unparseable value sorts lexically
    // between the two instants, opposite to their chronological order — and the
    // ranking would come out differently for each permutation of the input.
    const olderWithOffset = note({ slug: "alpha-window", updatedAt: "2026-11-01T12:00:00.000+09:00" }); // 03:00Z
    const newestInUtc = note({ slug: "beta-window", updatedAt: "2026-11-01T06:00:00.000Z" }); // 06:00Z
    const notAnInstant = note({ slug: "gamma-window", updatedAt: "2026-11-01T09:00:00.000+99:00" });

    const inputs = [
      [olderWithOffset, newestInUtc, notAnInstant],
      [olderWithOffset, notAnInstant, newestInUtc],
      [newestInUtc, olderWithOffset, notAnInstant],
      [newestInUtc, notAnInstant, olderWithOffset],
      [notAnInstant, olderWithOffset, newestInUtc],
      [notAnInstant, newestInUtc, olderWithOffset],
    ];

    for (const notes of inputs) {
      expect(slugs(search(notes, "replay"))).toEqual(["beta-window", "alpha-window", "gamma-window"]);
    }
  });

  test("returns exactly `limit` hits (AC-10)", () => {
    const notes = [note({ slug: "alpha-window" }), note({ slug: "beta-window" })];
    const hits = searchMemoryNotes(notes, "replay", 1);

    expect(hits).toHaveLength(1);
    expect(hits[0]?.slug).toBe("alpha-window");
  });

  test("returns an empty array for an empty or token-less query (AC-11)", () => {
    const notes = [note({ slug: "replay-budget" })];

    expect(searchMemoryNotes(notes, "", 10)).toEqual([]);
    expect(searchMemoryNotes(notes, "a", 10)).toEqual([]);
    // The same array does match a query that carries a token: the empty results
    // above come from the query, not from a search that never returns anything.
    expect(slugs(searchMemoryNotes(notes, "replay", 10))).toEqual(["replay-budget"]);
  });

  test("returns an empty array for a non-positive limit", () => {
    const notes = [note({ slug: "replay-budget" })];

    expect(searchMemoryNotes(notes, "replay", 0)).toEqual([]);
    expect(searchMemoryNotes(notes, "replay", -1)).toEqual([]);
    expect(slugs(searchMemoryNotes(notes, "replay", 1))).toEqual(["replay-budget"]);
  });
});

describe("searchMemoryNotes: hits", () => {
  test("carries the note's display fields (AC-12)", () => {
    const hit = onlyHit(search([note()], "replay"));

    expect(hit).toEqual({
      slug: "replay-budget",
      scope: "project",
      type: "project",
      description: "replay budget stays 2,048 MiB",
      status: "active",
      score: 3,
      snippet: "The replay budget stays at 2,048 MiB.",
    });
  });

  test("takes the snippet from the first body line holding a query token (AC-12)", () => {
    const body = "an intro line\nsecond line names the replay window\nthird line names the replay again\n";

    expect(onlyHit(search([note({ body })], "replay")).snippet).toBe("second line names the replay window");
  });

  test("cuts the snippet at 160 characters (AC-12)", () => {
    const longLine = `replay ${"x".repeat(200)}`;
    const snippet = onlyHit(search([note({ body: `intro\n${longLine}\n` })], "replay")).snippet;

    expect(snippet).toHaveLength(160);
    expect(longLine.startsWith(snippet)).toBe(true);
  });

  test("leaves the snippet empty for a slug match (AC-12)", () => {
    const slugMatch = note({ slug: "replay-window", description: "the log tail", body: "unrelated text\n" });
    const hit = onlyHit(search([slugMatch], "replay"));

    expect(hit.score).toBe(2);
    expect(hit.snippet).toBe("");
  });

  test("leaves the snippet empty for a description match (AC-12)", () => {
    const descriptionMatch = note({ slug: "log-tail", description: "replay window", body: "unrelated text\n" });

    expect(onlyHit(search([descriptionMatch], "replay")).snippet).toBe("");
  });
});

describe("public surface", () => {
  test("exports both search functions (AC-14)", () => {
    expect(entry.searchMemoryNotes).toBe(searchMemoryNotes);
    expect(entry.tokenizeMemoryQuery).toBe(tokenizeMemoryQuery);
  });
});
