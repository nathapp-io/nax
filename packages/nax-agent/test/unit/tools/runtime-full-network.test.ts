/**
 * The runtime's full-network sandbox decision, taken ONCE (US-002, #3053).
 *
 * A `network: "full"` Bash call runs outside the sandbox only after a human
 * approved an ask whose reason says so. Before US-002 the runtime never decided
 * that: Bash read `fullNetwork.isExposed()` again at LAUNCH, so a session that
 * was unexposed when the call was assessed and exposed by the time the ask came
 * back launched the command unwrapped with nobody told. The decision now belongs
 * to `callTool`, travels on `ToolRunContext.fullNetworkUnwrapped`, and Bash
 * reads it in preference to its own option.
 *
 * The tool driven here is the REAL `createBashTool` over a launcher that records
 * each request instead of running anything, so `unwrapped` reaching the launcher
 * is the same seam production uses.
 *
 * Companion controls live in `bash-full-network.test.ts` (US-002 ACs 8-10), where
 * the tool's own option is exercised without a runtime in between.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AskRequest, AskResolver } from "#src/permissions/index";
import type { CommandLauncher, LaunchRequest, SandboxRecord } from "#src/sandbox/index";
import { DISABLED_SANDBOX_STATE } from "#src/sandbox/index";
import type { WebExposurePort } from "#src/session/agent-session-types";
import { createBashTool } from "#src/tools/bash";
import { compileToolPolicy } from "#src/tools/policy";
import { type CodingToolRuntime, createCodingToolRuntime } from "#src/tools/runtime";
import { fullNetworkUnwrapped } from "#src/tools/runtime-full-network";
import { BASH_TOOL_NAME, type ToolGrant } from "#src/tools/types";
import { createWebExposure } from "#src/web/exposure";
import { createWebExposureGuard } from "#src/web/guard";
import { assertDefined, cleanupTempDir, makeTempDir } from "#test/helpers/index";

/** The one call every AC but AC-7 makes. */
const FULL_NETWORK_CALL = { command: "echo hi", network: "full" };

/** What a launcher records for a command it did not wrap. */
const NOT_WRAPPED: SandboxRecord = { backend: "none", wrapped: false };

/** The full-network row's reason, pinned to the wording US-012's guard renders. */
const FULL_NETWORK_REASON = "full network after this session read web content";

/** The clause US-002 appends once the runtime has decided the call runs unwrapped. */
const FULL_NETWORK_CLAUSE = "; runs OUTSIDE the sandbox: full network requested";

let root: string;

beforeEach(() => {
  root = makeTempDir("nax-runtime-full-network-");
});

afterEach(() => {
  cleanupTempDir(root);
});

/** A launcher that records every request instead of running anything. */
function recordingLauncher(requests: LaunchRequest[]): CommandLauncher {
  return {
    state: DISABLED_SANDBOX_STATE,
    async run(req) {
      requests.push(req);
      return { exitCode: 0, stdout: "ok", stderr: "", timedOut: false, executed: [], sandbox: NOT_WRAPPED };
    },
  };
}

/**
 * The session's REAL guard, exposed from the start. Used where the AC is about
 * the guard's own wording (AC-2) rather than about exposure changing: an
 * exposure never falls back, so a case that needs it flipped uses
 * `controlledPort` instead.
 */
function exposedGuard(): WebExposurePort {
  const exposure = createWebExposure();
  exposure.markExposed(new Date(0));
  return createWebExposureGuard({
    exposure,
    configuredAllowedDomains: undefined,
    exposedAllowedDomains: ["registry.npmjs.org"],
  });
}

/**
 * A port whose exposure the test flips mid-call, plus the flag itself, so a
 * case can prove the exposure really moved while the ask was open.
 */
function controlledPort(initiallyExposed: boolean): {
  readonly port: WebExposurePort;
  readonly isExposed: () => boolean;
  readonly setExposed: (exposed: boolean) => void;
} {
  let exposed = initiallyExposed;
  return {
    port: {
      exposedNetwork: () => (exposed ? ["registry.npmjs.org"] : undefined),
      assess: () => (exposed ? { rule: "web-exposure", reason: FULL_NETWORK_REASON } : undefined),
    },
    isExposed: () => exposed,
    setExposed: (next) => {
      exposed = next;
    },
  };
}

interface CallFixture {
  readonly runtime: CodingToolRuntime;
  readonly launches: LaunchRequest[];
  readonly asked: AskRequest[];
}

/**
 * One runtime serving the real Bash tool, a `Bash(*)` grant, the given exposure
 * port and an ask resolver that records every request. `beforeAnswer` runs
 * between the request being recorded and the decision, which is where a case
 * mutates the exposure.
 */
function callFixture(p: {
  readonly port: WebExposurePort;
  readonly decision?: "allow" | "deny";
  readonly beforeAnswer?: () => void;
  readonly askRules?: readonly ToolGrant[];
  /** False builds Bash WITHOUT its own `fullNetwork` option, so only the runtime can decide. */
  readonly offerFullNetwork?: boolean;
}): CallFixture {
  const launches: LaunchRequest[] = [];
  const asked: AskRequest[] = [];
  const tool = createBashTool({
    launcher: recordingLauncher(launches),
    ...(p.offerFullNetwork === false
      ? {}
      : { fullNetwork: { isExposed: () => p.port.exposedNetwork?.() !== undefined } }),
  });
  const askResolver: AskResolver = {
    resolve: async (request) => {
      asked.push(request);
      p.beforeAnswer?.();
      return { decision: p.decision ?? "allow", decidedBy: "human", latencyMs: 5 };
    },
  };
  const runtime = createCodingToolRuntime({
    policy: compileToolPolicy([{ tool: BASH_TOOL_NAME, patterns: ["*"] }], root, {
      ...(p.askRules !== undefined ? { askRules: p.askRules } : {}),
    }),
    extraTools: [tool],
    webExposure: p.port,
    // The sandbox is running, so the guard's "sandbox is off" row stays out of
    // these cases and every ask below is attributable to the full-network call.
    sandboxed: true,
    askResolver,
  });
  return { runtime, launches, asked };
}

describe("callTool — an exposed full-network Bash call asks, and says it runs outside the sandbox", () => {
  test("AC-1: the ask request carries unsandboxed: true", async () => {
    const { runtime, asked } = callFixture({ port: exposedGuard() });
    await runtime.callTool(BASH_TOOL_NAME, FULL_NETWORK_CALL);

    const request = asked[0];
    assertDefined(request, "the full-network ask");
    expect(request.unsandboxed).toBe(true);
  });

  test("AC-2: the reason names the exposure and the escape", async () => {
    const { runtime, asked } = callFixture({ port: exposedGuard() });
    await runtime.callTool(BASH_TOOL_NAME, FULL_NETWORK_CALL);

    const request = asked[0];
    assertDefined(request, "the full-network ask");
    expect(request.reason).toBe(`${FULL_NETWORK_REASON}${FULL_NETWORK_CLAUSE}`);
  });

  // Bash is built WITHOUT its own `fullNetwork` option here on purpose: the only
  // path that can report `unwrapped: true` is the runtime's decision arriving on
  // the run context, which is exactly the hand-off this AC is about.
  test("AC-3: the approved call launches unwrapped", async () => {
    const { runtime, launches, asked } = callFixture({ port: exposedGuard(), offerFullNetwork: false });
    await runtime.callTool(BASH_TOOL_NAME, FULL_NETWORK_CALL);

    expect(asked).toHaveLength(1);
    const launch = launches[0];
    assertDefined(launch, "the launcher request");
    expect(launch.unwrapped).toBe(true);
  });

  test("AC-6: an exposed session's ordinary Bash call asks without the escape marker", async () => {
    const { runtime, asked } = callFixture({
      port: exposedGuard(),
      askRules: [{ tool: BASH_TOOL_NAME, patterns: ["*"] }],
    });
    await runtime.callTool(BASH_TOOL_NAME, { command: "echo hi" });

    expect(asked).toHaveLength(1);
    const request = asked[0];
    assertDefined(request, "the ordinary policy ask");
    expect("unsandboxed" in request).toBe(false);
    expect(request.reason).not.toContain(FULL_NETWORK_CLAUSE);
  });

  test("AC-11: a denied full-network ask never reaches the launcher", async () => {
    const { runtime, launches, asked } = callFixture({ port: exposedGuard(), decision: "deny" });
    expect((await runtime.callTool(BASH_TOOL_NAME, FULL_NETWORK_CALL)).kind).toBe("denied");

    expect(asked).toHaveLength(1);
    expect(launches).toEqual([]);
  });
});

describe("callTool — the exposure an ask was raised under decides the launch", () => {
  // The defect #3053 shares with every "read it again at launch" shape: the
  // port is unexposed when the call is assessed and exposed by the time the
  // policy ask is approved. Bash's own `isExposed()` would now answer true, so
  // a launch that re-read it would run unwrapped with nobody told. Only
  // `unwrapped: false` proves the decision was frozen before the policy ran.
  test("AC-4: unexposed at assessment, exposed while the ask is open — launches wrapped", async () => {
    const controlled = controlledPort(false);
    const { runtime, launches, asked } = callFixture({
      port: controlled.port,
      askRules: [{ tool: BASH_TOOL_NAME, patterns: ["*"] }],
      beforeAnswer: () => controlled.setExposed(true),
    });
    await runtime.callTool(BASH_TOOL_NAME, FULL_NETWORK_CALL);

    expect(asked).toHaveLength(1);
    // The exposure really did move while the ask was open, so the tool's own
    // option would now claim the escape.
    expect(controlled.isExposed()).toBe(true);
    const launch = launches[0];
    assertDefined(launch, "the launcher request");
    expect(launch.unwrapped).toBe(false);
  });

  test("AC-5: exposed at assessment, unexposed while the ask is open — launches unwrapped", async () => {
    const controlled = controlledPort(true);
    const { runtime, launches, asked } = callFixture({
      port: controlled.port,
      beforeAnswer: () => controlled.setExposed(false),
    });
    await runtime.callTool(BASH_TOOL_NAME, FULL_NETWORK_CALL);

    expect(asked).toHaveLength(1);
    // The exposure did move the other way, so the tool's own option answers
    // false at launch; the approval that was granted was for an escape.
    expect(controlled.isExposed()).toBe(false);
    const launch = launches[0];
    assertDefined(launch, "the launcher request");
    expect(launch.unwrapped).toBe(true);
  });
});

describe("fullNetworkUnwrapped", () => {
  test("AC-7: Exec is not routed, even with a full network input and an exposed port", () => {
    expect(fullNetworkUnwrapped("Exec", { network: "full" }, controlledPort(true).port)).toBe(false);
  });

  test("Bash with a full network input under an exposed port is the one true case", () => {
    expect(fullNetworkUnwrapped(BASH_TOOL_NAME, { network: "full" }, controlledPort(true).port)).toBe(true);
  });

  test("no port, an unexposed port, another network value and no network input are all false", () => {
    expect(fullNetworkUnwrapped(BASH_TOOL_NAME, { network: "full" }, undefined)).toBe(false);
    expect(fullNetworkUnwrapped(BASH_TOOL_NAME, { network: "full" }, controlledPort(false).port)).toBe(false);
    expect(fullNetworkUnwrapped(BASH_TOOL_NAME, { network: "package" }, controlledPort(true).port)).toBe(false);
    expect(fullNetworkUnwrapped(BASH_TOOL_NAME, { command: "echo hi" }, controlledPort(true).port)).toBe(false);
  });
});
