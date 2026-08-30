/**
 * US-005 — `resolveIdleWatchdogSettings` is the single source of truth for the
 * five watchdog settings (idle/toolCallOnly/grace/maxRetryAttempts/activityKinds).
 *
 * The defaults must come from `DEFAULT_AGENT_IDLE_WATCHDOG_CONFIG` (the SSOT):
 *   - `idleTimeoutSeconds`: 900    → `idleTimeoutMs: 900000`
 *   - `toolCallOnlyIdleTimeoutSeconds`: 1800  → `toolCallOnlyTimeoutMs: 1800000`
 *   - `cancelGraceSeconds`: 10     → `graceMs: 10000`
 *   - `maxRetryAttempts`: 3        → `maxRetryAttempts: 3`
 *   - `activityKinds`: full default array
 *
 * AC5 in particular is the boundary that breaks the old `?? 5` inline default:
 * an explicit `cancelGraceSeconds: 0` must stay zero, not be silently promoted
 * to 10 (or 5, as the old inline default claimed).
 */

import { describe, expect, test } from "bun:test";
import { resolveIdleWatchdogSettings } from "@/runtime/middleware/idle-watchdog";

describe("resolveIdleWatchdogSettings — folds absent fields from the SSOT default", () => {
  test("AC1: returns idleTimeoutMs of 900000 when timing fields are all absent", () => {
    const result = resolveIdleWatchdogSettings({ enabled: true, mode: "warn-then-cancel" });
    expect(result.idleTimeoutMs).toBe(900000);
  });

  test("AC2: returns toolCallOnlyTimeoutMs of 1800000 when timing fields are all absent", () => {
    const result = resolveIdleWatchdogSettings({ enabled: true, mode: "warn-then-cancel" });
    expect(result.toolCallOnlyTimeoutMs).toBe(1800000);
  });

  test("AC3: returns graceMs of 10000 when timing fields are all absent", () => {
    const result = resolveIdleWatchdogSettings({ enabled: true, mode: "warn-then-cancel" });
    expect(result.graceMs).toBe(10000);
  });

  test("AC4: returns maxRetryAttempts of 3 when timing fields are all absent", () => {
    const result = resolveIdleWatchdogSettings({ enabled: true, mode: "warn-then-cancel" });
    expect(result.maxRetryAttempts).toBe(3);
  });

  test("AC5 (boundary): cancelGraceSeconds: 0 keeps graceMs at 0 — explicit zero is preserved", () => {
    const result = resolveIdleWatchdogSettings({
      enabled: true,
      mode: "warn-then-cancel",
      cancelGraceSeconds: 0,
    });
    expect(result.graceMs).toBe(0);
  });

  test("returns the full SSOT activityKinds list when activityKinds is absent", () => {
    const result = resolveIdleWatchdogSettings({ enabled: true, mode: "warn-then-cancel" });
    expect(result.activityKinds).toEqual(["message_update", "thinking_update", "usage_update", "tool_call_update"]);
  });

  test("converts each seconds field to milliseconds by multiplying by 1000", () => {
    const result = resolveIdleWatchdogSettings({
      enabled: true,
      mode: "warn-then-cancel",
      idleTimeoutSeconds: 42,
      toolCallOnlyIdleTimeoutSeconds: 84,
      cancelGraceSeconds: 7,
    });
    expect(result.idleTimeoutMs).toBe(42000);
    expect(result.toolCallOnlyTimeoutMs).toBe(84000);
    expect(result.graceMs).toBe(7000);
  });
});
