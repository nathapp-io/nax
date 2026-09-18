/**
 * Unit tests for src/prompts/builders/decompose-builder.ts
 *
 * Verifies buildDecomposePromptSync emits the repo-rooted path frame for
 * contextFiles (single-frame redesign).
 */

import { describe, expect, test } from "bun:test";
import { buildDecomposePromptSync } from "@/prompts";

describe("decompose-builder — repo-rooted path frame (single-frame redesign)", () => {
  test("spec-mode instructions state contextFiles is repo-rooted", () => {
    const prompt = buildDecomposePromptSync({ specContent: "spec", codebaseContext: "ctx" });
    expect(prompt).toContain("repo-rooted");
  });
});
