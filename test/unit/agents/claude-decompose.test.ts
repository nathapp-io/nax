/**
 * Tests for ClaudeCodeAdapter.decompose() — US-001
 *
 * Covers:
 * - decompose() forwards featureName to environment variables
 * - decompose() forwards storyId to environment variables
 * - decompose() forwards sessionRole to environment variables
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { ClaudeCodeAdapter, _decomposeDeps } from "../../../src/agents/claude/adapter";
import type { DecomposeOptions } from "../../../src/agents/types";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const SAMPLE_SPEC = `# Feature Spec
This is the specification for a new feature.
## Overview
Build an authentication system.`;

const SAMPLE_STORIES_JSON = JSON.stringify([
  {
    id: "US-001",
    title: "Implement login endpoint",
    description: "Create a POST /auth/login endpoint",
    acceptanceCriteria: ["Returns JWT on valid credentials"],
    tags: ["security", "api"],
    dependencies: [],
    complexity: "medium",
    contextFiles: ["src/auth/login.ts"],
    reasoning: "Standard auth endpoint",
    estimatedLOC: 80,
    risks: ["Token expiry handling"],
    testStrategy: "test-after",
  },
]);

const DECOMPOSE_WORKDIR = `/tmp/nax-claude-decompose-test-${randomUUID()}`;

function makeDecomposeOptions(overrides: Partial<DecomposeOptions> = {}): DecomposeOptions {
  return {
    specContent: SAMPLE_SPEC,
    workdir: DECOMPOSE_WORKDIR,
    codebaseContext: "TypeScript project with Express",
    modelDef: { provider: "anthropic", model: "claude-sonnet-4-5", env: {} },
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// decompose() — session context fields forwarding
// ─────────────────────────────────────────────────────────────────────────────

describe("decompose() — session context fields forwarding (CLI adapter)", () => {
  const origSpawn = _decomposeDeps.spawn;

  afterEach(() => {
    _decomposeDeps.spawn = origSpawn;
    mock.restore();
  });

  test("forwards options.featureName to environment variables", async () => {
    let capturedEnv: Record<string, string | undefined> = {};
    _decomposeDeps.spawn = mock((cmd: string[], opts: any) => {
      capturedEnv = opts.env || {};
      return {
        stdout: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(SAMPLE_STORIES_JSON));
            controller.close();
          },
        }),
        stderr: new ReadableStream({ start(controller) { controller.close(); } }),
        exited: Promise.resolve(0),
        pid: 12345,
      };
    }) as any;

    const featureName = "spec-decomposition";
    await new ClaudeCodeAdapter().decompose(makeDecomposeOptions({ featureName }));

    expect(capturedEnv.NAX_FEATURE_NAME).toBe(featureName);
  });

  test("forwards options.storyId to environment variables", async () => {
    let capturedEnv: Record<string, string | undefined> = {};
    _decomposeDeps.spawn = mock((cmd: string[], opts: any) => {
      capturedEnv = opts.env || {};
      return {
        stdout: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(SAMPLE_STORIES_JSON));
            controller.close();
          },
        }),
        stderr: new ReadableStream({ start(controller) { controller.close(); } }),
        exited: Promise.resolve(0),
        pid: 12345,
      };
    }) as any;

    const storyId = "US-123";
    await new ClaudeCodeAdapter().decompose(makeDecomposeOptions({ storyId }));

    expect(capturedEnv.NAX_STORY_ID).toBe(storyId);
  });

  test("forwards options.sessionRole to environment variables", async () => {
    let capturedEnv: Record<string, string | undefined> = {};
    _decomposeDeps.spawn = mock((cmd: string[], opts: any) => {
      capturedEnv = opts.env || {};
      return {
        stdout: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(SAMPLE_STORIES_JSON));
            controller.close();
          },
        }),
        stderr: new ReadableStream({ start(controller) { controller.close(); } }),
        exited: Promise.resolve(0),
        pid: 12345,
      };
    }) as any;

    const sessionRole = "decompose";
    await new ClaudeCodeAdapter().decompose(makeDecomposeOptions({ sessionRole }));

    expect(capturedEnv.NAX_SESSION_ROLE).toBe(sessionRole);
  });

  test("forwards featureName and storyId together to environment variables", async () => {
    let capturedEnv: Record<string, string | undefined> = {};
    _decomposeDeps.spawn = mock((cmd: string[], opts: any) => {
      capturedEnv = opts.env || {};
      return {
        stdout: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(SAMPLE_STORIES_JSON));
            controller.close();
          },
        }),
        stderr: new ReadableStream({ start(controller) { controller.close(); } }),
        exited: Promise.resolve(0),
        pid: 12345,
      };
    }) as any;

    const featureName = "feature-x";
    const storyId = "story-y";
    await new ClaudeCodeAdapter().decompose(makeDecomposeOptions({ featureName, storyId }));

    expect(capturedEnv.NAX_FEATURE_NAME).toBe(featureName);
    expect(capturedEnv.NAX_STORY_ID).toBe(storyId);
  });
});
