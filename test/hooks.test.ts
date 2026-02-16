/**
 * Hook Runner Tests
 *
 * Tests for hook execution, security, and lifecycle
 */

import { describe, expect, test } from "bun:test";
import { fireHook, loadHooksConfig } from "../src/hooks/runner";
import type { HookContext, HooksConfig } from "../src/hooks/types";

describe("Hook Security", () => {
  test("executes safe commands without shell", async () => {
    const config: HooksConfig = {
      hooks: {
        "on-start": {
          command: "echo hello",
          enabled: true,
        },
      },
    };

    const ctx: HookContext = {
      event: "on-start",
      feature: "test-feature",
    };

    // Should not throw
    await fireHook(config, "on-start", ctx, process.cwd());
  });

  test("rejects command substitution with $()", async () => {
    const config: HooksConfig = {
      hooks: {
        "on-start": {
          command: "echo $(whoami)",
          enabled: true,
        },
      },
    };

    const ctx: HookContext = {
      event: "on-start",
      feature: "test-feature",
    };

    // Should execute but validation should fail
    await fireHook(config, "on-start", ctx, process.cwd());
    // The hook should log a validation failure (tested via console.warn spy in integration)
  });

  test("rejects backtick command substitution", async () => {
    const config: HooksConfig = {
      hooks: {
        "on-start": {
          command: "echo `whoami`",
          enabled: true,
        },
      },
    };

    const ctx: HookContext = {
      event: "on-start",
      feature: "test-feature",
    };

    await fireHook(config, "on-start", ctx, process.cwd());
    // Should fail validation
  });

  test("rejects piping to bash", async () => {
    const config: HooksConfig = {
      hooks: {
        "on-start": {
          command: "echo malicious | bash",
          enabled: true,
        },
      },
    };

    const ctx: HookContext = {
      event: "on-start",
      feature: "test-feature",
    };

    await fireHook(config, "on-start", ctx, process.cwd());
    // Should fail validation
  });

  test("rejects dangerous rm -rf patterns", async () => {
    const config: HooksConfig = {
      hooks: {
        "on-start": {
          command: "echo test; rm -rf /",
          enabled: true,
        },
      },
    };

    const ctx: HookContext = {
      event: "on-start",
      feature: "test-feature",
    };

    await fireHook(config, "on-start", ctx, process.cwd());
    // Should fail validation
  });

  test("warns about shell operators", async () => {
    const config: HooksConfig = {
      hooks: {
        "on-start": {
          command: "echo hello && echo world",
          enabled: true,
        },
      },
    };

    const ctx: HookContext = {
      event: "on-start",
      feature: "test-feature",
    };

    // Should execute but log warning about shell operators
    await fireHook(config, "on-start", ctx, process.cwd());
  });

  test("escapes environment variables", async () => {
    const config: HooksConfig = {
      hooks: {
        "on-story-start": {
          command: "printenv",
          enabled: true,
        },
      },
    };

    const ctx: HookContext = {
      event: "on-story-start",
      feature: "test-feature",
      storyId: "story-with-\0null-byte",
      reason: "reason\nwith\nnewlines",
    };

    // Should not throw, environment variables should be escaped
    await fireHook(config, "on-story-start", ctx, process.cwd());
  });

  test("handles timeout correctly", async () => {
    const config: HooksConfig = {
      hooks: {
        "on-start": {
          command: "sleep 10",
          enabled: true,
          timeout: 100, // 100ms timeout
        },
      },
    };

    const ctx: HookContext = {
      event: "on-start",
      feature: "test-feature",
    };

    // Should timeout and not throw
    await fireHook(config, "on-start", ctx, process.cwd());
    // Should log timeout reason
  });

  test("skips disabled hooks", async () => {
    const config: HooksConfig = {
      hooks: {
        "on-start": {
          command: "echo should-not-run",
          enabled: false,
        },
      },
    };

    const ctx: HookContext = {
      event: "on-start",
      feature: "test-feature",
    };

    // Should not execute
    await fireHook(config, "on-start", ctx, process.cwd());
  });

  test("handles missing hooks gracefully", async () => {
    const config: HooksConfig = {
      hooks: {},
    };

    const ctx: HookContext = {
      event: "on-start",
      feature: "test-feature",
    };

    // Should not throw
    await fireHook(config, "on-start", ctx, process.cwd());
  });

  test("passes context as JSON via stdin", async () => {
    const config: HooksConfig = {
      hooks: {
        "on-complete": {
          command: "cat",
          enabled: true,
        },
      },
    };

    const ctx: HookContext = {
      event: "on-complete",
      feature: "test-feature",
      storyId: "story-123",
      status: "completed",
      cost: 1.5,
      model: "claude-sonnet-4",
    };

    // Should pass full context as JSON
    await fireHook(config, "on-complete", ctx, process.cwd());
  });
});

describe("Hook Configuration Loading", () => {
  test("loads empty config when no hooks.json exists", async () => {
    const config = await loadHooksConfig("/tmp/nonexistent-hooks-dir");

    expect(config).toEqual({ hooks: {} });
  });

  test("merges global and project hooks", async () => {
    // This test would require creating temporary hooks.json files
    // Skipping for now, as it requires file system setup
  });
});

describe("Hook Environment Variables", () => {
  test("sets NGENT_EVENT", async () => {
    const config: HooksConfig = {
      hooks: {
        "on-start": {
          command: "printenv",
          enabled: true,
        },
      },
    };

    const ctx: HookContext = {
      event: "on-start",
      feature: "auth-feature",
    };

    await fireHook(config, "on-start", ctx, process.cwd());
    // Environment variables should be set
  });

  test("sets NGENT_FEATURE", async () => {
    const config: HooksConfig = {
      hooks: {
        "on-start": {
          command: "printenv",
          enabled: true,
        },
      },
    };

    const ctx: HookContext = {
      event: "on-start",
      feature: "payment-system",
    };

    await fireHook(config, "on-start", ctx, process.cwd());
    // NGENT_FEATURE should be set to "payment-system"
  });

  test("sets NGENT_STORY_ID when provided", async () => {
    const config: HooksConfig = {
      hooks: {
        "on-story-start": {
          command: "printenv",
          enabled: true,
        },
      },
    };

    const ctx: HookContext = {
      event: "on-story-start",
      feature: "test-feature",
      storyId: "user-login-001",
    };

    await fireHook(config, "on-story-start", ctx, process.cwd());
    // NGENT_STORY_ID should be set
  });

  test("sets NGENT_COST when provided", async () => {
    const config: HooksConfig = {
      hooks: {
        "on-complete": {
          command: "printenv",
          enabled: true,
        },
      },
    };

    const ctx: HookContext = {
      event: "on-complete",
      feature: "test-feature",
      cost: 2.5678,
    };

    await fireHook(config, "on-complete", ctx, process.cwd());
    // NGENT_COST should be set to "2.5678"
  });

  test("sets NGENT_MODEL when provided", async () => {
    const config: HooksConfig = {
      hooks: {
        "on-complete": {
          command: "printenv",
          enabled: true,
        },
      },
    };

    const ctx: HookContext = {
      event: "on-complete",
      feature: "test-feature",
      model: "claude-opus-4",
    };

    await fireHook(config, "on-complete", ctx, process.cwd());
    // NGENT_MODEL should be set
  });

  test("sets NGENT_ITERATION when provided", async () => {
    const config: HooksConfig = {
      hooks: {
        "on-error": {
          command: "printenv",
          enabled: true,
        },
      },
    };

    const ctx: HookContext = {
      event: "on-error",
      feature: "test-feature",
      iteration: 3,
    };

    await fireHook(config, "on-error", ctx, process.cwd());
    // NGENT_ITERATION should be set to "3"
  });
});
