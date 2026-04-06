/**
 * Unit tests for featureName forwarding in runReview (US-002 AC-2)
 *
 * Tests cover:
 * - AC-2: runReview() signature includes featureName? and forwards it to runSemanticReview()
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  _reviewGitDeps as _deps,
  _reviewSemanticDeps as _semanticDeps,
  runReview,
} from "../../../src/review/runner";
import type { ReviewConfig } from "../../../src/review/types";

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

const semanticOnlyConfig: ReviewConfig = {
  enabled: true,
  checks: ["semantic"],
  commands: {},
};

const PASSING_SEMANTIC_RESULT = {
  check: "semantic" as const,
  success: true,
  command: "",
  exitCode: 0,
  output: "passed",
  durationMs: 0,
};

// ---------------------------------------------------------------------------
// AC-2: runReview forwards featureName to runSemanticReview
// ---------------------------------------------------------------------------

describe("runReview — featureName forwarding to runSemanticReview (US-002 AC-2)", () => {
  let origGetUncommittedFiles: typeof _deps.getUncommittedFiles;
  let origRunSemanticReview: typeof _semanticDeps.runSemanticReview;

  beforeEach(() => {
    origGetUncommittedFiles = _deps.getUncommittedFiles;
    origRunSemanticReview = _semanticDeps.runSemanticReview;
    // Clean working tree so review proceeds past dirty-tree guard
    _deps.getUncommittedFiles = mock(async () => []);
  });

  afterEach(() => {
    _deps.getUncommittedFiles = origGetUncommittedFiles;
    _semanticDeps.runSemanticReview = origRunSemanticReview;
    mock.restore();
  });

  test("forwards featureName to runSemanticReview when provided", async () => {
    const semanticMock = mock(async () => PASSING_SEMANTIC_RESULT);
    _semanticDeps.runSemanticReview = semanticMock;

    await runReview(
      semanticOnlyConfig,
      "/tmp/workdir",
      undefined, // executionConfig
      undefined, // qualityCommands
      "US-002",  // storyId
      "abc123",  // storyGitRef
      undefined, // story
      undefined, // modelResolver
      undefined, // naxConfig
      undefined, // retrySkipChecks
      "my-feature", // featureName
    );

    expect(semanticMock).toHaveBeenCalled();
    // runSemanticReview(workdir, storyGitRef, story, semanticCfg, modelResolver, naxConfig, featureName)
    // featureName is the 7th arg (index 6)
    const callArgs = semanticMock.mock.calls[0] as unknown[];
    expect(callArgs[6]).toBe("my-feature");
  });

  test("forwards undefined featureName to runSemanticReview when not provided", async () => {
    const semanticMock = mock(async () => PASSING_SEMANTIC_RESULT);
    _semanticDeps.runSemanticReview = semanticMock;

    await runReview(semanticOnlyConfig, "/tmp/workdir");

    expect(semanticMock).toHaveBeenCalled();
    const callArgs = semanticMock.mock.calls[0] as unknown[];
    // featureName should be undefined when not provided
    expect(callArgs[6]).toBeUndefined();
  });

  test("review result is still successful when featureName is provided", async () => {
    _semanticDeps.runSemanticReview = mock(async () => PASSING_SEMANTIC_RESULT);

    const result = await runReview(
      semanticOnlyConfig,
      "/tmp/workdir",
      undefined,
      undefined,
      "US-002",
      "abc123",
      undefined,
      undefined,
      undefined,
      undefined,
      "my-feature",
    );

    expect(result.success).toBe(true);
  });
});
