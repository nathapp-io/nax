/**
 * Tests for src/utils/tokens.ts
 *
 * `estimateTokens` is the shared token heuristic. It lived in the deleted
 * optimizer module; these tests pin the leaf module and the two barrel
 * re-exports that kept their public surface.
 */

import { describe, expect, test } from "bun:test";
import { estimateTokens as fromConstitution } from "@/constitution";
import { estimateTokens as fromContext } from "@/context";
import { estimateTokens } from "@/utils/tokens";

describe("estimateTokens", () => {
  test("rounds a partial token up: five characters is two tokens", () => {
    expect(estimateTokens("abcde")).toBe(2);
  });

  test("returns one token for a full four characters", () => {
    expect(estimateTokens("abcd")).toBe(1);
  });

  test("returns zero for an empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });
});

describe("estimateTokens barrel re-exports", () => {
  test("@/context re-exports the same function as @/utils/tokens", () => {
    expect(fromContext).toBe(estimateTokens);
  });

  test("@/constitution re-exports the same function as @/utils/tokens", () => {
    expect(fromConstitution).toBe(estimateTokens);
  });
});
