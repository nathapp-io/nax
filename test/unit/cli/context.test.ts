/**
 * AC-19: nax context inspect — formatContextInspect
 *
 * Tests the human-readable formatter for context manifests.
 * Passes StoredContextManifest[] directly to avoid disk I/O.
 */

import { describe, expect, test } from "bun:test";
import { formatContextInspect } from "../../../src/cli/context";
import type { StoredContextManifest } from "../../../src/context/engine/manifest-store";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeManifest(overrides: Partial<StoredContextManifest["manifest"]> = {}): StoredContextManifest["manifest"] {
  return {
    requestId: "req-001",
    stage: "verify",
    totalBudgetTokens: 2000,
    usedTokens: 1200,
    includedChunks: ["provider-a:chunk-1", "provider-a:chunk-2", "provider-b:chunk-3"],
    excludedChunks: [
      { id: "provider-a:chunk-4", reason: "budget" },
      { id: "provider-b:chunk-5", reason: "below-min-score" },
    ],
    floorItems: [],
    digestTokens: 120,
    buildMs: 42,
    providerResults: [
      { providerId: "provider-a", status: "ok", chunkCount: 2, durationMs: 25, tokensProduced: 800 },
      { providerId: "provider-b", status: "ok", chunkCount: 1, durationMs: 17, tokensProduced: 400 },
    ],
    ...overrides,
  };
}

function makeEntry(stage: string, overrides: Partial<StoredContextManifest["manifest"]> = {}): StoredContextManifest {
  return {
    featureId: "my-feature",
    stage,
    path: `/repo/.nax/features/my-feature/stories/US-001/context-manifest-${stage}.json`,
    manifest: makeManifest({ stage, ...overrides }),
  };
}

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1B\[[0-9;]*m/g, "");
}

function lines(output: string[]): string[] {
  return output.map(stripAnsi);
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("formatContextInspect", () => {
  test("shows 'No context manifests found' when list is empty", () => {
    const output = lines(formatContextInspect("US-001", []));
    const joined = output.join("\n");
    expect(joined).toContain("No context manifests found");
    expect(joined).toContain("US-001");
  });

  test("shows story ID in header", () => {
    const output = lines(formatContextInspect("US-001", [makeEntry("verify")]));
    expect(output.join("\n")).toContain("US-001");
  });

  test("shows feature ID and stage", () => {
    const output = lines(formatContextInspect("US-001", [makeEntry("verify")]));
    const joined = output.join("\n");
    expect(joined).toContain("my-feature");
    expect(joined).toContain("verify");
  });

  test("shows token budget: used / total", () => {
    const output = lines(formatContextInspect("US-001", [makeEntry("verify")]));
    const joined = output.join("\n");
    expect(joined).toContain("1200");
    expect(joined).toContain("2000");
  });

  test("shows included chunk count", () => {
    const output = lines(formatContextInspect("US-001", [makeEntry("verify")]));
    expect(output.join("\n")).toContain("3");
  });

  test("shows excluded chunk count", () => {
    const output = lines(formatContextInspect("US-001", [makeEntry("verify")]));
    expect(output.join("\n")).toContain("2");
  });

  test("shows buildMs", () => {
    const output = lines(formatContextInspect("US-001", [makeEntry("verify")]));
    expect(output.join("\n")).toContain("42");
  });

  test("shows provider ID, status, chunkCount, tokensProduced, durationMs", () => {
    const output = lines(formatContextInspect("US-001", [makeEntry("verify")]));
    const joined = output.join("\n");
    expect(joined).toContain("provider-a");
    expect(joined).toContain("ok");
    expect(joined).toContain("800");
    expect(joined).toContain("25");
  });

  test("shows failed provider status", () => {
    const entry = makeEntry("verify", {
      providerResults: [
        { providerId: "git-history", status: "failed", chunkCount: 0, durationMs: 5, tokensProduced: 0, error: "timeout exceeded" },
      ],
    });
    const output = lines(formatContextInspect("US-001", [entry]));
    const joined = output.join("\n");
    expect(joined).toContain("failed");
    expect(joined).toContain("git-history");
  });

  test("shows timeout provider status", () => {
    const entry = makeEntry("verify", {
      providerResults: [
        { providerId: "git-history", status: "timeout", chunkCount: 0, durationMs: 5000, tokensProduced: 0 },
      ],
    });
    const output = lines(formatContextInspect("US-001", [entry]));
    expect(output.join("\n")).toContain("timeout");
  });

  test("shows excluded chunk IDs and reasons", () => {
    const output = lines(formatContextInspect("US-001", [makeEntry("verify")]));
    const joined = output.join("\n");
    expect(joined).toContain("provider-a:chunk-4");
    expect(joined).toContain("budget");
    expect(joined).toContain("provider-b:chunk-5");
    expect(joined).toContain("below-min-score");
  });

  test("shows multiple stages separately", () => {
    const manifests = [makeEntry("context"), makeEntry("verify")];
    const output = lines(formatContextInspect("US-001", manifests));
    const joined = output.join("\n");
    expect(joined).toContain("context");
    expect(joined).toContain("verify");
  });

  test("omits excluded section when excludedChunks is empty", () => {
    const entry = makeEntry("verify", { excludedChunks: [] });
    const output = lines(formatContextInspect("US-001", [entry]));
    expect(output.join("\n")).not.toContain("Excluded");
  });

  test("omits providers section when providerResults is absent", () => {
    const entry = makeEntry("verify", { providerResults: undefined });
    const output = lines(formatContextInspect("US-001", [entry]));
    expect(output.join("\n")).not.toContain("Providers");
  });

  test("shows floor items when present", () => {
    const entry = makeEntry("verify", { floorItems: ["static:chunk-1", "static:chunk-2"] });
    const output = lines(formatContextInspect("US-001", [entry]));
    expect(output.join("\n")).toContain("Floor");
  });

  test("shows floorOverageItems when present", () => {
    const entry = makeEntry("verify", {
      floorItems: ["static:chunk-1"],
      floorOverageItems: ["static:chunk-1"],
    });
    const output = lines(formatContextInspect("US-001", [entry]));
    expect(output.join("\n")).toContain("overage");  // shown in floor line
  });

  test("shows digestTokens", () => {
    const output = lines(formatContextInspect("US-001", [makeEntry("verify")]));
    expect(output.join("\n")).toContain("120");
  });

  test("shows provider error message when present", () => {
    const entry = makeEntry("verify", {
      providerResults: [
        { providerId: "git-history", status: "failed", chunkCount: 0, durationMs: 5, tokensProduced: 0, error: "ENOENT: file not found" },
      ],
    });
    const output = lines(formatContextInspect("US-001", [entry]));
    expect(output.join("\n")).toContain("ENOENT");
  });
});
