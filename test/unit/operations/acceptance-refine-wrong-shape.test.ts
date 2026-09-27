/**
 * US-003 (acceptance-refine fails loud): a correct-length array whose items
 * carry no refinement is unusable output, not a silent fallback.
 *
 * `refinementWouldFallback` treats a non-empty array in which no item carries a
 * usable `refined` string as a fallback, so `acceptanceRefineOp.parse` rejects
 * it — running the op's retry budget and leaving the caller to mark the story's
 * criteria `refinementFallback: true` — instead of handing back the unrefined
 * criteria unchecked behind a matching count.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { makeTestRuntime, opSelector } from "@test/helpers";
import { refinementWouldFallback } from "@/acceptance";
import { ParseValidationError } from "@/agents/retry";
import { acceptanceRefineOp } from "@/operations";
import type { AcceptanceRefineInput } from "@/operations/acceptance-refine";
import type { NaxRuntime } from "@/runtime";

const createdRuntimes: NaxRuntime[] = [];
afterEach(async () => {
  await Promise.allSettled(createdRuntimes.map((r) => r.close()));
  createdRuntimes.length = 0;
});

const THREE_CRITERIA_INPUT: AcceptanceRefineInput = {
  criteria: ["a", "b", "c"],
  codebaseContext: "",
  storyId: "US-004",
};

function makeCtx() {
  const runtime = makeTestRuntime();
  createdRuntimes.push(runtime);
  const view = runtime.packages.repo();
  return { packageView: view, config: view.select(opSelector(acceptanceRefineOp.config)) };
}

describe("US-003: correct-length arrays with no usable refinement are rejected", () => {
  // Every one of these has exactly `THREE_CRITERIA_INPUT.criteria.length` items,
  // so the count check alone cannot catch them.
  test.each([
    ['["a","b","c"]', "strings"],
    ["[1,2,3]", "numbers"],
    ["[null,null,null]", "nulls"],
    ["[[],{},true]", "non-object scalars"],
  ] as const)("US-003: throws ParseValidationError for an array of %s", (output) => {
    expect(() => acceptanceRefineOp.parse(output, THREE_CRITERIA_INPUT, makeCtx())).toThrow(ParseValidationError);
  });

  test("US-003: the rejection names the unusable output rather than a count shortfall", () => {
    expect(() => acceptanceRefineOp.parse("[1,2,3]", THREE_CRITERIA_INPUT, makeCtx())).toThrow(
      "acceptance-refine: unusable refinement output",
    );
  });

  test("US-003 boundary: refinementWouldFallback agrees, and still not for an empty array", () => {
    expect(refinementWouldFallback("[1,2,3]")).toBe(true);
    expect(refinementWouldFallback('["a","b","c"]')).toBe(true);
    expect(refinementWouldFallback("[null]")).toBe(true);
    // An empty array is a successful parse; the op's count check rejects it.
    expect(refinementWouldFallback("[]")).toBe(false);
  });

  test("US-003 boundary: an array of usable refinement objects still parses", () => {
    const json = JSON.stringify([
      { original: "a", refined: "a() returns true" },
      { original: "b", refined: "b() returns true" },
      { original: "c", refined: "c() returns true" },
    ]);
    expect(refinementWouldFallback(json)).toBe(false);
    const result = acceptanceRefineOp.parse(json, THREE_CRITERIA_INPUT, makeCtx());
    expect(result.map((c) => c.refined)).toEqual(["a() returns true", "b() returns true", "c() returns true"]);
  });

  test("US-003 boundary: a partially refined array is rejected too, not half-applied", () => {
    // The parser throws on the null items and falls back for the WHOLE array,
    // so the one usable item must not make the output look acceptable.
    const json = JSON.stringify([{ refined: "a() returns true" }, null, null]);
    expect(refinementWouldFallback(json)).toBe(true);
    expect(() => acceptanceRefineOp.parse(json, THREE_CRITERIA_INPUT, makeCtx())).toThrow(ParseValidationError);
  });

  test("US-003 boundary: an item without a refined string is not usable", () => {
    const json = JSON.stringify([
      { original: "a", refined: "a() returns true" },
      { original: "b" },
      { original: "c", refined: "c() returns true" },
    ]);
    expect(refinementWouldFallback(json)).toBe(true);
    expect(() => acceptanceRefineOp.parse(json, THREE_CRITERIA_INPUT, makeCtx())).toThrow(ParseValidationError);
  });
});
