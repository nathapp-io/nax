/**
 * `detectForge` with an explicit forge kind (US-001).
 *
 * Detection classifies by host and then probes the installed CLI. A self-hosted
 * forge on a neutral host on a machine carrying both `gh` and `glab` resolves to
 * null, so the caller's declared kind has to win — and has to win before any
 * subprocess runs, since the whole point is to answer what probing cannot.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { _forgeKind, defaultForgeDeps, detectForge, type ForgeDeps } from "@/forge";

/** A host that names neither forge — the case the explicit kind exists for. */
const NEUTRAL_REMOTE = "https://git.corp.example/group/app.git";

const OK = { exitCode: 0, stdout: "", stderr: "" };

interface CapturedRun {
  cmd: string[];
}

beforeEach(() => {
  _forgeKind.current = undefined;
});

afterEach(() => {
  _forgeKind.current = undefined;
});

/**
 * A fake runner for a neutral-host repository with both forge CLIs installed —
 * the shape today's detection cannot resolve.
 */
function neutralHostWithBothClis(captured?: CapturedRun[]): ForgeDeps["run"] {
  return async (cmd) => {
    captured?.push({ cmd });
    if (cmd[0] === "git") return { exitCode: 0, stdout: `${NEUTRAL_REMOTE}\n`, stderr: "" };
    return OK;
  };
}

describe("detectForge with deps.explicitKind", () => {
  test("AC-12: returns the explicit kind without reading origin or probing a CLI", async () => {
    const captured: CapturedRun[] = [];
    const deps: ForgeDeps = {
      run: neutralHostWithBothClis(captured),
      readText: async () => null,
      explicitKind: async () => "gitlab",
    };

    expect(await detectForge(deps, "/repo")).toBe("gitlab");
    expect(captured).toEqual([]);
  });

  test("AC-13: falls through to today's detection when no kind is declared", async () => {
    const deps: ForgeDeps = {
      run: neutralHostWithBothClis(),
      readText: async () => null,
      explicitKind: async () => undefined,
    };

    expect(await detectForge(deps, "/repo")).toBeNull();
  });

  test("AC-13: a fake written before the feature still detects exactly as before", async () => {
    const deps: ForgeDeps = {
      run: neutralHostWithBothClis(),
      readText: async () => null,
    };

    expect(await detectForge(deps, "/repo")).toBeNull();
  });

  test("AC-14: defaultForgeDeps answers from the captured NAX_FORGE_KIND", async () => {
    _forgeKind.current = "gitlab";
    const deps: ForgeDeps = { ...defaultForgeDeps, run: neutralHostWithBothClis() };

    expect(await detectForge(deps, "/repo")).toBe("gitlab");
  });
});
