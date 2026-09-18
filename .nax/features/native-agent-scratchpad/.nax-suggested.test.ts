import { describe, expect, test } from "bun:test";
import { buildNaxArtifactsSection } from "../../../src/prompts/sections";

const roles = ["test-writer", "implementer", "verifier"] as const;
const variants = ["standard", "lite"] as const;

function sentences(text: string): string[] {
  return text.replace(/`/g, "").replace(/\s+/g, " ").split(/(?<=[.!?])\s+/);
}

describe("native-agent-scratchpad acceptance", () => {
  test("AC-1: scratchpad is the sole exception to .nax/ immutability", () => {
    for (const role of roles) {
      for (const variant of variants) {
        const rendered = buildNaxArtifactsSection(role, variant);
        const normalized = rendered.replace(/`/g, "").replace(/\s+/g, " ");
        const exceptionSentences = sentences(rendered).filter((sentence) => /\bexception\b/i.test(sentence));

        // The sole exception is explicitly and exclusively scoped to the scratchpad.
        expect(exceptionSentences).toHaveLength(1);
        expect(exceptionSentences[0]).toMatch(/\.nax\/scratchpad\//i);
        expect(exceptionSentences[0]).not.toMatch(/\.nax\/(?!scratchpad\/)/i);

        // The general .nax/ rule remains a prohibition on all three destructive operations.
        expect(normalized).toMatch(
          /files under \.nax\/.*must never be moved, renamed, or deleted/i,
        );

        // No statement may grant destructive-operation permission to the general
        // .nax/ directory or to any path other than the scratchpad.
        for (const sentence of sentences(rendered)) {
          const grantsPermission = /\b(?:may|can|allowed|allow|permit|permitted|freely)\b/i.test(sentence);
          const mentionsDestructiveOperation = /\b(?:move|moved|rename|renamed|delete|deleted)\b/i.test(sentence);
          const naxPaths = sentence.match(/\.nax\/[^\s,.;:)\]`"]*/g) ?? [];

          if (grantsPermission && mentionsDestructiveOperation && naxPaths.length > 0) {
            expect(naxPaths).toEqual([".nax/scratchpad/"]);
          }
        }
      }
    }
  });
});