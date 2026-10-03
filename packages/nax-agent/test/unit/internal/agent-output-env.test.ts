/**
 * Unit tests for src/utils/agent-output-env.ts (US-004).
 *
 * The overlay is decided from the nax process environment (via
 * `_agentOutputEnvDeps.processEnv`, which tests replace) plus the caller's
 * strip list — never from the child's own inherited env, which the spawn site
 * does not build.
 */

import { describe, expect, test } from "bun:test";
import {
  _agentOutputEnvDeps,
  AGENT_OUTPUT_MARKERS,
  agentOutputOverlay,
  withAgentOutputEnv,
} from "#src/internal/agent-output-env";
import { withDepsRestore } from "#test/helpers/index";

const MARKER_FREE = { PATH: "/usr/bin", HOME: "/home/x" };

describe("agentOutputOverlay (US-004)", () => {
  withDepsRestore(_agentOutputEnvDeps, ["processEnv"]);

  test("US-004 AC1: returns { AGENT: '1' } when no marker is inherited", () => {
    _agentOutputEnvDeps.processEnv = () => ({ ...MARKER_FREE });

    expect(agentOutputOverlay([])).toEqual({ AGENT: "1" });
  });

  test("US-004 AC2: returns undefined when CLAUDECODE is inherited", () => {
    _agentOutputEnvDeps.processEnv = () => ({ ...MARKER_FREE, CLAUDECODE: "1" });

    expect(agentOutputOverlay([])).toBeUndefined();
  });

  test("US-004 AC2 boundary: every other marker in the set suppresses the overlay too", () => {
    for (const marker of ["REPL_ID", "AGENT"]) {
      _agentOutputEnvDeps.processEnv = () => ({ ...MARKER_FREE, [marker]: "1" });
      expect(agentOutputOverlay([])).toBeUndefined();
    }
  });

  test("US-004 AC3: returns undefined when the environment carries AGENT: '0'", () => {
    // Presence, not truthiness: an explicit AGENT=0 still says "this child
    // already knows it is running under an agent", so nax must not override it.
    _agentOutputEnvDeps.processEnv = () => ({ ...MARKER_FREE, AGENT: "0" });

    expect(agentOutputOverlay([])).toBeUndefined();
  });

  test("US-004 AC4: returns undefined when AGENT is in the caller's strip list", () => {
    _agentOutputEnvDeps.processEnv = () => ({ ...MARKER_FREE });

    expect(agentOutputOverlay(["AGENT"])).toBeUndefined();
  });

  test("US-004 AC4 boundary: only a stripped AGENT suppresses the overlay", () => {
    _agentOutputEnvDeps.processEnv = () => ({ ...MARKER_FREE });

    expect(agentOutputOverlay(["NPM_TOKEN", "AWS_SECRET_ACCESS_KEY"])).toEqual({ AGENT: "1" });
  });

  test("the default processEnv reads the nax process environment", () => {
    process.env.NAX_AGENT_OUTPUT_PROBE = "1";
    try {
      expect(_agentOutputEnvDeps.processEnv().NAX_AGENT_OUTPUT_PROBE).toBe("1");
    } finally {
      delete process.env.NAX_AGENT_OUTPUT_PROBE;
    }
  });
});

describe("withAgentOutputEnv", () => {
  test("adds AGENT=1 to an env with no marker, leaving the input untouched", () => {
    const env = { ...MARKER_FREE };

    expect(withAgentOutputEnv(env)).toEqual({ ...MARKER_FREE, AGENT: "1" });
    expect(env).toEqual(MARKER_FREE);
  });

  test("returns the same env when any marker is present", () => {
    for (const marker of AGENT_OUTPUT_MARKERS) {
      const env = { ...MARKER_FREE, [marker]: "1" };

      expect(withAgentOutputEnv(env)).toBe(env);
    }
  });

  test("returns the same env when the caller stripped AGENT", () => {
    const env = { ...MARKER_FREE };

    expect(withAgentOutputEnv(env, ["AGENT"])).toBe(env);
  });
});
