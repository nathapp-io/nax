/**
 * Tests for src/plugins/validator.ts
 *
 * Covers: plugin validation including post-run-action validation
 */

import { describe, expect, it } from "bun:test";
import { validatePlugin } from "../../../src/plugins/validator";

// ─────────────────────────────────────────────────────────────────────────────
// validatePlugin with post-run-action
// ─────────────────────────────────────────────────────────────────────────────

describe("validatePlugin with post-run-action", () => {
  it("rejects if postRunAction missing name field", () => {
    const invalidPlugin = {
      name: "bad-pra-plugin",
      version: "1.0.0",
      provides: ["post-run-action"],
      extensions: {
        postRunAction: {
          // missing name
          description: "Test action",
          shouldRun: async () => true,
          execute: async () => ({ success: true, message: "ok" }),
        },
      },
    };

    const result = validatePlugin(invalidPlugin);
    expect(result).toBeNull();
  });

  it("rejects if postRunAction missing description field", () => {
    const invalidPlugin = {
      name: "bad-pra-plugin",
      version: "1.0.0",
      provides: ["post-run-action"],
      extensions: {
        postRunAction: {
          name: "test-action",
          // missing description
          shouldRun: async () => true,
          execute: async () => ({ success: true, message: "ok" }),
        },
      },
    };

    const result = validatePlugin(invalidPlugin);
    expect(result).toBeNull();
  });

  it("rejects if postRunAction.name is not a string", () => {
    const invalidPlugin = {
      name: "bad-pra-plugin",
      version: "1.0.0",
      provides: ["post-run-action"],
      extensions: {
        postRunAction: {
          name: 123, // not a string
          description: "Test action",
          shouldRun: async () => true,
          execute: async () => ({ success: true, message: "ok" }),
        },
      },
    };

    const result = validatePlugin(invalidPlugin);
    expect(result).toBeNull();
  });

  it("rejects if postRunAction.description is not a string", () => {
    const invalidPlugin = {
      name: "bad-pra-plugin",
      version: "1.0.0",
      provides: ["post-run-action"],
      extensions: {
        postRunAction: {
          name: "test-action",
          description: 456, // not a string
          shouldRun: async () => true,
          execute: async () => ({ success: true, message: "ok" }),
        },
      },
    };

    const result = validatePlugin(invalidPlugin);
    expect(result).toBeNull();
  });

  it("rejects if postRunAction missing shouldRun function", () => {
    const invalidPlugin = {
      name: "bad-pra-plugin",
      version: "1.0.0",
      provides: ["post-run-action"],
      extensions: {
        postRunAction: {
          name: "test-action",
          description: "Test action",
          // missing shouldRun
          execute: async () => ({ success: true, message: "ok" }),
        },
      },
    };

    const result = validatePlugin(invalidPlugin);
    expect(result).toBeNull();
  });

  it("rejects if postRunAction.shouldRun is not a function", () => {
    const invalidPlugin = {
      name: "bad-pra-plugin",
      version: "1.0.0",
      provides: ["post-run-action"],
      extensions: {
        postRunAction: {
          name: "test-action",
          description: "Test action",
          shouldRun: "not a function", // not a function
          execute: async () => ({ success: true, message: "ok" }),
        },
      },
    };

    const result = validatePlugin(invalidPlugin);
    expect(result).toBeNull();
  });

  it("rejects if postRunAction missing execute function", () => {
    const invalidPlugin = {
      name: "bad-pra-plugin",
      version: "1.0.0",
      provides: ["post-run-action"],
      extensions: {
        postRunAction: {
          name: "test-action",
          description: "Test action",
          shouldRun: async () => true,
          // missing execute
        },
      },
    };

    const result = validatePlugin(invalidPlugin);
    expect(result).toBeNull();
  });

  it("rejects if postRunAction.execute is not a function", () => {
    const invalidPlugin = {
      name: "bad-pra-plugin",
      version: "1.0.0",
      provides: ["post-run-action"],
      extensions: {
        postRunAction: {
          name: "test-action",
          description: "Test action",
          shouldRun: async () => true,
          execute: "not a function", // not a function
        },
      },
    };

    const result = validatePlugin(invalidPlugin);
    expect(result).toBeNull();
  });

  it("validates a correct post-run-action plugin", () => {
    const validPlugin = {
      name: "good-pra-plugin",
      version: "1.0.0",
      provides: ["post-run-action"],
      extensions: {
        postRunAction: {
          name: "test-action",
          description: "Test action",
          shouldRun: async () => true,
          execute: async () => ({ success: true, message: "ok" }),
        },
      },
    };

    const result = validatePlugin(validPlugin);
    expect(result).not.toBeNull();
  });
});
