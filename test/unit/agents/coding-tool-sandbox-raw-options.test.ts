/**
 * US-002: the raw-screen options the sync tool seam spreads into
 * `compileToolPolicy`. `rawRefusalFor` answers "is Bash refused entirely?";
 * `rawScreenOptionsFor` answers that AND whether the command the agent is
 * about to run is wrapped by the sandbox -- which is what lets the raw screen
 * stop refusing a PRD the agent only wants to READ.
 *
 * A separate file from coding-tool-sandbox.test.ts because this covers an
 * export that did not exist before the story; keeping it apart leaves the
 * module's other tests runnable on their own.
 */
import { describe, expect, test } from "bun:test";
import { rawRefusalFor, rawScreenOptionsFor } from "@/agents/coding-tool-sandbox";
import { createCommandLauncher, DISABLED_SANDBOX_STATE, rawBashRefusalReason } from "@/sandbox";

const available = () => createCommandLauncher({ state: { kind: "available", backend: "srt", network: "open" } });
const unavailableLauncher = () =>
  createCommandLauncher({ state: { kind: "unavailable", backend: "srt", reason: "no bwrap" } });
const disabled = () => createCommandLauncher({ state: DISABLED_SANDBOX_STATE });

describe("rawScreenOptionsFor (US-002)", () => {
  test("AC13: an available launcher means the raw screen is sandbox-wrapped", () => {
    expect(rawScreenOptionsFor(available())).toEqual({ sandboxWrapped: true });
  });

  test("AC14: an unavailable launcher carries the refusal, and is NOT sandbox-wrapped", () => {
    expect(rawScreenOptionsFor(unavailableLauncher())).toEqual({
      rawBashRefusal: rawBashRefusalReason("no bwrap"),
    });
  });

  test("AC14 boundary: the refusal is exactly what rawRefusalFor returns, for every launcher state", () => {
    for (const launcher of [undefined, disabled(), unavailableLauncher(), available()]) {
      expect(rawScreenOptionsFor(launcher).rawBashRefusal).toBe(rawRefusalFor(launcher));
    }
  });

  test("AC15: a disabled launcher yields no options at all", () => {
    expect(rawScreenOptionsFor(disabled())).toEqual({});
  });

  test("AC15 boundary: an absent launcher yields no options at all", () => {
    expect(rawScreenOptionsFor(undefined)).toEqual({});
  });
});
