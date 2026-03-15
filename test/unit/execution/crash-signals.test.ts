/**
 * Tests for crash-signals.ts — installSignalHandlers
 *
 * Verifies that signal handlers are correctly registered and removed.
 * BUG-1: unhandledRejection handler must use a stable reference so
 * removeListener can actually deregister it.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { installSignalHandlers } from "../../../src/execution/crash-signals";
import type { SignalHandlerContext } from "../../../src/execution/crash-signals";
import type { StatusWriter } from "../../../src/execution/status-writer";

const minimalCtx: SignalHandlerContext = {
  getTotalCost: () => 0,
  getIterations: () => 0,
  statusWriter: {} as StatusWriter,
};

describe("installSignalHandlers", () => {
  let cleanup: (() => void) | undefined;

  afterEach(() => {
    // Always run cleanup to avoid leaking handlers if a test fails mid-way
    cleanup?.();
    cleanup = undefined;
  });

  test("unhandledRejection listener count increases by 1 after install (BUG-1)", () => {
    const before = process.listenerCount("unhandledRejection");
    cleanup = installSignalHandlers(minimalCtx);
    expect(process.listenerCount("unhandledRejection")).toBe(before + 1);
  });

  test("unhandledRejection listener is removed after cleanup — returns to original count (BUG-1)", () => {
    const before = process.listenerCount("unhandledRejection");
    cleanup = installSignalHandlers(minimalCtx);
    cleanup();
    cleanup = undefined;
    expect(process.listenerCount("unhandledRejection")).toBe(before);
  });

  test("uncaughtException listener is removed after cleanup", () => {
    const before = process.listenerCount("uncaughtException");
    cleanup = installSignalHandlers(minimalCtx);
    cleanup();
    cleanup = undefined;
    expect(process.listenerCount("uncaughtException")).toBe(before);
  });
});
