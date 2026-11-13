/**
 * flow-builder.ts — the fixed instructions the `nax-flow` provider carries.
 *
 * Pure fixed text: no config, no file reads, no model calls, so the assertions
 * here are on what the brain is told, not on how it is assembled.
 */

import { describe, expect, test } from "bun:test";
import { buildFlowInstructions } from "@/prompts";

describe("buildFlowInstructions", () => {
  test("names the tool and states that koda runs its own approval (AC-3)", () => {
    const text = buildFlowInstructions();

    expect(text).toContain("nax-flow__send");
    expect(text).toContain("koda asks for its own approval before anything billed starts");
  });

  test("says the tool is for a user asking to hand specs to koda", () => {
    expect(buildFlowInstructions()).toContain("only when the user asks");
  });

  test("requires a clean, committed branch and counts untracked files", () => {
    const text = buildFlowInstructions();

    expect(text).toContain("clean working tree");
    expect(text).toContain("untracked");
  });

  test("asks for the features in dependency order", () => {
    expect(buildFlowInstructions()).toContain("dependency order");
  });

  test("tells the brain the user approves twice: the card, then koda", () => {
    const text = buildFlowInstructions();

    expect(text).toContain("approval card");
    expect(text).toContain("approves the flow again in koda");
  });
});
