import { describe, expect, test } from "bun:test";
import type { FindingTrigger } from "@/workflow/blocking-findings";
import { FINDING_TRIGGERS, parseFindingTrigger } from "@/workflow/blocking-findings";

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
