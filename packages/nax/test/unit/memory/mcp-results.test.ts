/**
 * mcp-results.ts — pure adapters from MCP tool-result text to memory items,
 * remote ids and `MemoryHit`s.
 *
 * Covers US-002 AC-1..AC-15.
 */

import { describe, expect, test } from "bun:test";
import {
  MCP_HIT_DESCRIPTION_MAX_CHARS,
  MCP_HIT_SNIPPET_MAX_CHARS,
  mcpHitOf,
  parseMcpMemoryIds,
  parseMcpMemoryItems,
} from "@/memory/mcp-results";

describe("parseMcpMemoryItems", () => {
  test("reads id, text and score from a JSON array item (AC-1)", () => {
    expect(parseMcpMemoryItems('[{"id":"a1","memory":"uses bun","score":0.9}]')).toEqual([
      { id: "a1", text: "uses bun", score: 0.9 },
    ]);
  });

  test("reads the items of an object with a results array (AC-2)", () => {
    expect(parseMcpMemoryItems('{"results":[{"id":"a1","memory":"uses bun"}]}')).toEqual([
      { id: "a1", text: "uses bun" },
    ]);
  });

  test("takes text from the text and content fields too (AC-3)", () => {
    expect(parseMcpMemoryItems('[{"text":"t1"},{"content":"t2"}]')).toEqual([{ text: "t1" }, { text: "t2" }]);
  });

  test("drops an item with no text field (AC-4)", () => {
    expect(parseMcpMemoryItems('[{"id":"a1"},{"id":"a2","memory":"kept"}]')).toEqual([{ id: "a2", text: "kept" }]);
  });

  test("returns [] for text that is not JSON (AC-5)", () => {
    expect(parseMcpMemoryItems("not json")).toEqual([]);
  });

  test("returns [] for an object whose list is not under results (AC-6)", () => {
    expect(parseMcpMemoryItems('{"memories":[{"memory":"x"}]}')).toEqual([]);
  });

  test("prefers memory over text over content when several are strings", () => {
    expect(parseMcpMemoryItems('[{"content":"c","text":"t","memory":"m"},{"memory":5,"content":"c2"}]')).toEqual([
      { text: "m" },
      { text: "c2" },
    ]);
  });

  test("ignores a non-string id and a non-number score", () => {
    expect(parseMcpMemoryItems('[{"id":7,"memory":"x","score":"high"},{"memory":"y","score":null}]')).toEqual([
      { text: "x" },
      { text: "y" },
    ]);
  });

  test("drops items that are not objects and returns [] for a JSON scalar", () => {
    expect(parseMcpMemoryItems('[null,"s",3,[],{"memory":"ok"}]')).toEqual([{ text: "ok" }]);
    expect(parseMcpMemoryItems("42")).toEqual([]);
    expect(parseMcpMemoryItems('{"results":"nope"}')).toEqual([]);
  });
});

describe("parseMcpMemoryIds", () => {
  test("returns every string id, with or without a text field (AC-7)", () => {
    const text = '{"results":[{"id":"r1","event":"ADD"},{"memory":"no id"},{"id":"r2","memory":"m"}]}';
    expect(parseMcpMemoryIds(text)).toEqual(["r1", "r2"]);
  });

  test("returns [] for text that is not JSON (AC-8)", () => {
    expect(parseMcpMemoryIds("ok")).toEqual([]);
  });

  test("reads ids from a bare array and skips non-string ids", () => {
    expect(parseMcpMemoryIds('[{"id":"a"},{"id":4},{"id":"b"}]')).toEqual(["a", "b"]);
  });
});

describe("mcpHitOf", () => {
  test("maps an item with id, multi-line text and score to a hit (AC-9)", () => {
    expect(mcpHitOf({ id: "AB_12", text: "line one\nline two", score: 0.5 }, 0, "project")).toEqual({
      slug: "mcp-ab-12",
      scope: "project",
      type: "reference",
      status: "active",
      description: "line one",
      snippet: "line one\nline two",
      score: 0.5,
    });
  });

  test("numbers the slug from the index when the item has no id (AC-10)", () => {
    expect(mcpHitOf({ text: "x" }, 2, "user").slug).toBe("mcp-3");
  });

  test("carries the requested scope (AC-11)", () => {
    expect(mcpHitOf({ text: "x" }, 2, "user").scope).toBe("user");
  });

  test("scores 0 when the item has no score (AC-12)", () => {
    expect(mcpHitOf({ text: "x" }, 2, "user").score).toBe(0);
  });

  test("cuts the snippet to MCP_HIT_SNIPPET_MAX_CHARS (AC-13)", () => {
    const hit = mcpHitOf({ text: "a".repeat(2000) }, 0, "project");
    expect(MCP_HIT_SNIPPET_MAX_CHARS).toBe(1000);
    expect(hit.snippet).toHaveLength(MCP_HIT_SNIPPET_MAX_CHARS);
  });

  test("cuts the slug to mcp- plus 60 characters (AC-14)", () => {
    const letters = "abcdefghij".repeat(10);
    const hit = mcpHitOf({ id: letters, text: "x" }, 0, "project");
    expect(hit.slug).toHaveLength(64);
    expect(hit.slug).toBe(`mcp-${letters.slice(0, 60)}`);
  });

  test("cuts a single-line description to MCP_HIT_DESCRIPTION_MAX_CHARS (AC-15)", () => {
    const hit = mcpHitOf({ text: "d".repeat(300) }, 0, "project");
    expect(MCP_HIT_DESCRIPTION_MAX_CHARS).toBe(160);
    expect(hit.description).toHaveLength(MCP_HIT_DESCRIPTION_MAX_CHARS);
  });
});
