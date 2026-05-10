/**
 * Tests for pickSelectorKind dispatcher — US-003 AC4-5
 *
 * Covers:
 * - AC4: pickSelectorKind returns stageConfig.selector.kind when defined
 * - AC4: pickSelectorKind returns 'dialogue-verdict' when auto-elevation applies
 * - AC5: pickSelectorKind maps resolver.type to selector kind
 */

import { describe, expect, test } from "bun:test";
import type { DebateStageConfig, ResolverType } from "../../../../src/debate/types";
import type { ResolverContextInput } from "../../../../src/debate/session-helpers";
import { pickSelectorKind } from "../../../../src/debate/selectors";
import type { ReviewerSession } from "../../../../src/review/dialogue";

describe("pickSelectorKind dispatcher (US-003 AC4-5)", () => {
  const makeStageConfig = (overrides?: Partial<DebateStageConfig>): DebateStageConfig => ({
    enabled: true,
    sessionMode: "one-shot",
    rounds: 2,
    resolver: {
      type: "synthesis" as ResolverType,
      ...overrides?.resolver,
    },
    ...overrides,
  });

  const mockResolverContextInput: ResolverContextInput = {
    diffMode: "embedded",
    diff: "test diff",
    story: { id: "story-1", title: "Test", acceptanceCriteria: ["AC1"] },
    semanticConfig: { diffMode: "embedded" },
    resolverType: "synthesis",
  };

  const mockReviewerSession = {} as ReviewerSession;

  describe("AC4: explicit selector field wins", () => {
    test("returns stageConfig.selector.kind when selector is defined as dialogue-verdict", () => {
      const stageConfig = makeStageConfig({
        selector: { kind: "dialogue-verdict" },
      });
      const ctx = { reviewerSession: mockReviewerSession };

      const result = pickSelectorKind(stageConfig, ctx);
      expect(result).toBe("dialogue-verdict");
    });

    test("returns stageConfig.selector.kind when selector is synthesis", () => {
      const stageConfig = makeStageConfig({
        selector: { kind: "synthesis" },
      });
      const ctx = {};

      const result = pickSelectorKind(stageConfig, ctx);
      expect(result).toBe("synthesis");
    });

    test("returns stageConfig.selector.kind when selector is judge", () => {
      const stageConfig = makeStageConfig({
        selector: { kind: "judge" },
      });
      const ctx = {};

      const result = pickSelectorKind(stageConfig, ctx);
      expect(result).toBe("judge");
    });

    test("explicit selector takes precedence over auto-elevation", () => {
      const stageConfig = makeStageConfig({
        selector: { kind: "synthesis" },
        resolver: { type: "synthesis" },
      });
      const ctx = {
        reviewerSession: mockReviewerSession,
        resolverContextInput: mockResolverContextInput,
      };

      const result = pickSelectorKind(stageConfig, ctx);
      expect(result).toBe("synthesis");
    });
  });

  describe("AC4: auto-elevation to dialogue-verdict", () => {
    test("returns 'dialogue-verdict' when both reviewerSession and resolverContextInput are present", () => {
      const stageConfig = makeStageConfig({
        resolver: { type: "synthesis" },
      });
      const ctx = {
        reviewerSession: mockReviewerSession,
        resolverContextInput: mockResolverContextInput,
      };

      const result = pickSelectorKind(stageConfig, ctx);
      expect(result).toBe("dialogue-verdict");
    });

    test("does not auto-elevate when only reviewerSession is present", () => {
      const stageConfig = makeStageConfig({
        resolver: { type: "synthesis" },
      });
      const ctx = {
        reviewerSession: mockReviewerSession,
      };

      const result = pickSelectorKind(stageConfig, ctx);
      expect(result).toBe("synthesis");
    });

    test("does not auto-elevate when only resolverContextInput is present", () => {
      const stageConfig = makeStageConfig({
        resolver: { type: "synthesis" },
      });
      const ctx = {
        resolverContextInput: mockResolverContextInput,
      };

      const result = pickSelectorKind(stageConfig, ctx);
      expect(result).toBe("synthesis");
    });

    test("does not auto-elevate when neither is present", () => {
      const stageConfig = makeStageConfig({
        resolver: { type: "synthesis" },
      });
      const ctx = {};

      const result = pickSelectorKind(stageConfig, ctx);
      expect(result).toBe("synthesis");
    });
  });

  describe("AC5: map resolver.type to selector kind", () => {
    test("maps 'synthesis' to 'synthesis'", () => {
      const stageConfig = makeStageConfig({
        resolver: { type: "synthesis" },
      });
      const ctx = {};

      const result = pickSelectorKind(stageConfig, ctx);
      expect(result).toBe("synthesis");
    });

    test("maps 'majority-fail-closed' to 'majority-fail-closed'", () => {
      const stageConfig = makeStageConfig({
        resolver: { type: "majority-fail-closed" },
      });
      const ctx = {};

      const result = pickSelectorKind(stageConfig, ctx);
      expect(result).toBe("majority-fail-closed");
    });

    test("maps 'majority-fail-open' to 'majority-fail-open'", () => {
      const stageConfig = makeStageConfig({
        resolver: { type: "majority-fail-open" },
      });
      const ctx = {};

      const result = pickSelectorKind(stageConfig, ctx);
      expect(result).toBe("majority-fail-open");
    });

    test("maps 'custom' to 'judge'", () => {
      const stageConfig = makeStageConfig({
        resolver: { type: "custom" },
      });
      const ctx = {};

      const result = pickSelectorKind(stageConfig, ctx);
      expect(result).toBe("judge");
    });
  });

  describe("fallback precedence", () => {
    test("explicit selector takes precedence over auto-elevation which takes precedence over resolver mapping", () => {
      const stageConfig = makeStageConfig({
        selector: { kind: "synthesis" },
        resolver: { type: "custom" },
      });
      const ctx = {
        reviewerSession: mockReviewerSession,
        resolverContextInput: mockResolverContextInput,
      };

      const result = pickSelectorKind(stageConfig, ctx);
      expect(result).toBe("synthesis");
    });

    test("auto-elevation takes precedence over resolver mapping", () => {
      const stageConfig = makeStageConfig({
        resolver: { type: "synthesis" },
      });
      const ctx = {
        reviewerSession: mockReviewerSession,
        resolverContextInput: mockResolverContextInput,
      };

      const result = pickSelectorKind(stageConfig, ctx);
      expect(result).toBe("dialogue-verdict");
    });
  });
});
