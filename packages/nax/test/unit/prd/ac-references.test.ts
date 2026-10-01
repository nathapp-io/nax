import { describe, expect, test } from "bun:test";
import { findAcNumericReferences } from "@/prd";

/**
 * `findAcNumericReferences` is the SSOT for "does this text reference another
 * AC by number?". The plan prompt splits compound criteria and renumbers the
 * rest, so a number in an AC can silently point at a different criterion in the
 * PRD. The function strips inline code spans so a quoted `AC-1: a` (e.g. a test
 * title in a backticked phrase) is data, not a pointer.
 */
describe("findAcNumericReferences", () => {
  test("AC-1: returns AC-7 from 'In the AC-7 shape, a write fails'", () => {
    expect(findAcNumericReferences("In the AC-7 shape, a write fails")).toEqual(["AC-7"]);
  });

  test("AC-2: normalises the space form AC 14 to the hyphen form AC-14", () => {
    expect(findAcNumericReferences("Given the AC 14 setup, the call is rejected")).toEqual(["AC-14"]);
  });

  test("AC-3: dedupes repeated references in first-seen order", () => {
    expect(findAcNumericReferences("AC-3 holds, then AC-12 and AC-3 again")).toEqual(["AC-3", "AC-12"]);
  });

  test("AC-4: ignores AC-ERROR and AC-HOOK sentinels (no digits)", () => {
    expect(findAcNumericReferences('failedACs equals ["AC-ERROR"] and the AC-HOOK sentinel is set')).toEqual([]);
  });

  test("AC-5: ignores an AC token sitting inside an inline code span", () => {
    expect(findAcNumericReferences("the test titled `AC-1: a` passes")).toEqual([]);
  });

  test("AC-6: returns [] when no numeric AC reference is present", () => {
    expect(findAcNumericReferences("the refined criterion is returned unchanged")).toEqual([]);
  });
});
