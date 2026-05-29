/**
 * Tests for pickSelectorKind dispatcher — US-003 AC4-5
 *
 * Covers:
 * - AC4: pickSelectorKind returns stageConfig.selector.kind when defined
 * - AC5: pickSelectorKind maps resolver.type to selector kind
 */

import { describe, expect, test } from "bun:test";
import type { DebateStageConfig, ResolverType } from "@/debate/types";
import { pickSelectorKind } from "@/debate";

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

  describe("AC4: explicit selector field wins", () => {
    test("returns stageConfig.selector.kind when selector is synthesis", () => {
      const stageConfig = makeStageConfig({ selector: { kind: "synthesis" } });
      expect(pickSelectorKind(stageConfig)).toBe("synthesis");
    });

    test("returns stageConfig.selector.kind when selector is judge", () => {
      const stageConfig = makeStageConfig({ selector: { kind: "judge" } });
      expect(pickSelectorKind(stageConfig)).toBe("judge");
    });

    test("explicit selector takes precedence over resolver mapping", () => {
      const stageConfig = makeStageConfig({
        selector: { kind: "synthesis" },
        resolver: { type: "custom" },
      });
      expect(pickSelectorKind(stageConfig)).toBe("synthesis");
    });
  });

  describe("AC5: map resolver.type to selector kind", () => {
    test("maps 'synthesis' to 'synthesis'", () => {
      const stageConfig = makeStageConfig({ resolver: { type: "synthesis" } });
      expect(pickSelectorKind(stageConfig)).toBe("synthesis");
    });

    test("maps 'majority-fail-closed' to 'majority-fail-closed'", () => {
      const stageConfig = makeStageConfig({ resolver: { type: "majority-fail-closed" } });
      expect(pickSelectorKind(stageConfig)).toBe("majority-fail-closed");
    });

    test("maps 'majority-fail-open' to 'majority-fail-open'", () => {
      const stageConfig = makeStageConfig({ resolver: { type: "majority-fail-open" } });
      expect(pickSelectorKind(stageConfig)).toBe("majority-fail-open");
    });

    test("maps 'custom' to 'judge'", () => {
      const stageConfig = makeStageConfig({ resolver: { type: "custom" } });
      expect(pickSelectorKind(stageConfig)).toBe("judge");
    });
  });

  test("dialogue-verdict is no longer a valid selector kind via auto-elevation", () => {
    // No auto-elevation path exists — dialogue-verdict must be explicit if used
    const stageConfig = makeStageConfig({ resolver: { type: "synthesis" } });
    expect(pickSelectorKind(stageConfig)).toBe("synthesis");
    expect(pickSelectorKind(stageConfig)).not.toBe("dialogue-verdict");
  });
});
