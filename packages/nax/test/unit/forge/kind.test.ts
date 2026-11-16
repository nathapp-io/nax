/**
 * Unit tests for the explicit forge kind (US-001).
 *
 * `_forgeKind.current` is process-local: a value leaked out of one test would
 * decide another suite's forge, so every test here resets it — along with the
 * `_forgeKindDeps.configuredKind` seam — in `afterEach`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { assertNaxError } from "@test/helpers";
import { NaxError } from "@/errors";
import type { ForgeKind } from "@/forge";
import { _forgeKind, captureForgeKind, FORGE_KIND_ENV, resolveExplicitForgeKind } from "@/forge";
import { _forgeKindDeps } from "@/forge/kind";

type Env = Record<string, string | undefined>;

let originalConfiguredKind: typeof _forgeKindDeps.configuredKind;

beforeEach(() => {
  originalConfiguredKind = _forgeKindDeps.configuredKind;
  _forgeKind.current = undefined;
});

afterEach(() => {
  _forgeKindDeps.configuredKind = originalConfiguredKind;
  _forgeKind.current = undefined;
});

/** Stub the config seam so a test never reads a real `.nax/config.json`. */
function configuredKindReturns(kind: ForgeKind | undefined, calls?: string[]): void {
  _forgeKindDeps.configuredKind = async (repoRoot: string) => {
    calls?.push(repoRoot);
    return kind;
  };
}

/** Await a `captureForgeKind` rejection and narrow it to `NaxError`. */
function captureRejection(env: Env): NaxError {
  let caught: unknown;
  try {
    captureForgeKind(env);
  } catch (err) {
    caught = err;
  }
  assertNaxError(caught, "captureForgeKind rejection");
  return caught;
}

describe("captureForgeKind", () => {
  test("AC-1: returns gitlab and stores it in _forgeKind.current", () => {
    expect(captureForgeKind({ [FORGE_KIND_ENV]: "gitlab" })).toBe("gitlab");
    expect(_forgeKind.current).toBe("gitlab");
  });

  test("AC-2: trims the value before accepting it", () => {
    expect(captureForgeKind({ [FORGE_KIND_ENV]: " github " })).toBe("github");
    expect(_forgeKind.current).toBe("github");
  });

  test("AC-3: an absent variable clears a previously captured kind", () => {
    _forgeKind.current = "github";

    expect(captureForgeKind({})).toBeUndefined();
    expect(_forgeKind.current).toBeUndefined();
  });

  test("AC-3: a whitespace-only variable counts as absent", () => {
    _forgeKind.current = "github";

    expect(captureForgeKind({ [FORGE_KIND_ENV]: "   " })).toBeUndefined();
    expect(_forgeKind.current).toBeUndefined();
  });

  test("AC-4: rejects an unknown forge with FORGE_KIND_INVALID and the exact message", () => {
    const error = captureRejection({ [FORGE_KIND_ENV]: "bitbucket" });

    expect(error).toBeInstanceOf(NaxError);
    expect(error.code).toBe("FORGE_KIND_INVALID");
    expect(error.message).toBe('[forge] Invalid NAX_FORGE_KIND "bitbucket": expected github or gitlab');
  });

  test("AC-5: rejects a differently-cased accepted value", () => {
    const error = captureRejection({ [FORGE_KIND_ENV]: "GitLab" });

    expect(error).toBeInstanceOf(NaxError);
    expect(error.code).toBe("FORGE_KIND_INVALID");
  });

  test("AC-6: a rejected capture leaves _forgeKind.current undefined", () => {
    _forgeKind.current = "github";

    captureRejection({ [FORGE_KIND_ENV]: "bitbucket" });

    expect(_forgeKind.current).toBeUndefined();
  });
});

describe("resolveExplicitForgeKind", () => {
  test("AC-7: the captured env kind wins over forge.kind", async () => {
    _forgeKind.current = "github";
    configuredKindReturns("gitlab");

    expect(await resolveExplicitForgeKind("/repo")).toBe("github");
  });

  test("AC-8: falls back to forge.kind from the config for repoRoot", async () => {
    const calls: string[] = [];
    configuredKindReturns("gitlab", calls);

    expect(await resolveExplicitForgeKind("/repo")).toBe("gitlab");
    expect(calls).toEqual(["/repo"]);
  });

  test("AC-9: a failing config read leaves the explicit kind undefined", async () => {
    _forgeKindDeps.configuredKind = async () => {
      throw new Error("Invalid configuration");
    };

    expect(await resolveExplicitForgeKind("/repo")).toBeUndefined();
  });
});
