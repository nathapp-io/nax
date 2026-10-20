import { describe, expect, test } from "bun:test";
import { BOT_FIX_GRAPH, BOT_REVIEW_GRAPH } from "@/bot";
import { validateStepGraph } from "@/step-graph";

describe("public bot graph declarations", () => {
  test("AC-14 BOT_FIX_GRAPH passes the shared validator", () => {
    expect(validateStepGraph(BOT_FIX_GRAPH)).toEqual({ errors: [] });
  });
  test("AC-15 BOT_REVIEW_GRAPH passes the shared validator", () => {
    expect(validateStepGraph(BOT_REVIEW_GRAPH)).toEqual({ errors: [] });
  });
});
