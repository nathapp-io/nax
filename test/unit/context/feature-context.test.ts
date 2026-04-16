/**
 * Tests for feature-context provider.
 *
 * Uses _featureContextDeps injection pattern — no mock.module().
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  FeatureContextProvider,
  _featureContextDeps,
} from "../../../src/context/providers/feature-context";
import type { NaxConfig } from "../../../src/config/types";
import type { UserStory } from "../../../src/prd";
import { DEFAULT_CONFIG } from "../../../src/config";

function makeStory(id: string): UserStory {
  return {
    id,
    title: `Story ${id}`,
    description: "Test story",
    acceptanceCriteria: ["AC1"],
    tags: [],
    dependencies: [],
    status: "pending",
    passes: false,
    escalations: [],
    attempts: 0,
  };
}

function makeConfig(enabled: boolean, budgetTokens = 2048): NaxConfig {
  return {
    ...DEFAULT_CONFIG,
    context: {
      ...DEFAULT_CONFIG.context,
      featureEngine: {
        enabled,
        budgetTokens,
      },
    },
  };
}

describe("FeatureContextProvider", () => {
  let origResolveFeatureId: typeof _featureContextDeps.resolveFeatureId;
  let origReadFile: typeof _featureContextDeps.readFile;
  let origFileExists: typeof _featureContextDeps.fileExists;

  beforeEach(() => {
    origResolveFeatureId = _featureContextDeps.resolveFeatureId;
    origReadFile = _featureContextDeps.readFile;
    origFileExists = _featureContextDeps.fileExists;
  });

  afterEach(() => {
    _featureContextDeps.resolveFeatureId = origResolveFeatureId;
    _featureContextDeps.readFile = origReadFile;
    _featureContextDeps.fileExists = origFileExists;
  });

  test("returns null when feature engine disabled", async () => {
    const provider = new FeatureContextProvider();
    const story = makeStory("US-001");
    const config = makeConfig(false);
    const result = await provider.getContext(story, "/workdir", config);
    expect(result).toBeNull();
  });

  test("returns null when story not attached to any feature", async () => {
    _featureContextDeps.resolveFeatureId = async () => null;

    const provider = new FeatureContextProvider();
    const story = makeStory("US-001");
    const config = makeConfig(true);
    const result = await provider.getContext(story, "/workdir", config);
    expect(result).toBeNull();
  });

  test("returns null when context.md does not exist", async () => {
    _featureContextDeps.resolveFeatureId = async () => "my-feature";
    _featureContextDeps.fileExists = async () => false;

    const provider = new FeatureContextProvider();
    const story = makeStory("US-001");
    const config = makeConfig(true);
    const result = await provider.getContext(story, "/workdir", config);
    expect(result).toBeNull();
  });

  test("returns null when context.md is empty", async () => {
    _featureContextDeps.resolveFeatureId = async () => "my-feature";
    _featureContextDeps.fileExists = async () => true;
    _featureContextDeps.readFile = async () => "   \n  ";

    const provider = new FeatureContextProvider();
    const story = makeStory("US-001");
    const config = makeConfig(true);
    const result = await provider.getContext(story, "/workdir", config);
    expect(result).toBeNull();
  });

  test("returns FeatureContextResult with correct label and featureId when context.md exists", async () => {
    const contextContent = "## Notes\n\n- **Entry.** `[all]`\n  Some context here.\n";
    _featureContextDeps.resolveFeatureId = async () => "auth-feature";
    _featureContextDeps.fileExists = async () => true;
    _featureContextDeps.readFile = async () => contextContent;

    const provider = new FeatureContextProvider();
    const story = makeStory("US-005");
    const config = makeConfig(true);
    const result = await provider.getContext(story, "/workdir", config);

    expect(result).not.toBeNull();
    expect(result!.label).toBe("feature-context:auth-feature");
    expect(result!.featureId).toBe("auth-feature");
    expect(result!.content).toContain("## Feature Context");
    expect(result!.content).toContain("_Feature: auth-feature_");
    expect(result!.content).toContain("Some context here.");
    expect(result!.estimatedTokens).toBeGreaterThan(0);
  });

  test("returns null and warns when file read throws an error", async () => {
    _featureContextDeps.resolveFeatureId = async () => "broken-feature";
    _featureContextDeps.fileExists = async () => true;
    _featureContextDeps.readFile = async () => {
      throw new Error("Permission denied");
    };

    const provider = new FeatureContextProvider();
    const story = makeStory("US-001");
    const config = makeConfig(true);
    const result = await provider.getContext(story, "/workdir", config);
    expect(result).toBeNull();
  });
});
