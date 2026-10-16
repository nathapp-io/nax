/**
 * The owned-path screen on a case-insensitive filesystem (#2347).
 *
 * `.nax/config.json` is the trust anchor for ungated commands, and the screen
 * matched it -- and `.nax/features/<f>/prd.json`, and the root queue files --
 * exact-case. On a case-insensitive volume the case-variant spelling reaches the
 * same file, so this file pins the fold on all three entries the story closes:
 * the raw Bash screen (`naxOwnedPathsPolicy.bashRefusal`), the path resolver
 * (nax-agent's `resolveWithin`, through the injected `configRefusal`) and the
 * typed-write path (`naxOwnedWriteRefusal`).
 *
 * A temp root sidesteps any question about the host volume: every answer here
 * comes from the stubbed `_caseFsDeps.stat`, which the probe consults and
 * `realOrRaw` never does. The cache is keyed by root, so ACs 14 and 17 give one
 * root opposite answers -- hence the reset in `afterEach`.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { resolveWithin } from "@nathapp/nax-agent";
import { cleanupTempDir, makeTempDir, withDepsRestore } from "@test/helpers";
import { _caseFsDeps, _resetCaseFsCache, isCaseInsensitiveFs } from "@/agents/case-insensitive-fs";
import { createConfigReadGatePolicy } from "@/agents/config-read-gate";
import {
  isNaxConfigSegments,
  naxOwnedKind,
  naxOwnedPathsPolicy,
  naxOwnedWriteRefusal,
} from "@/agents/nax-owned-writes";

withDepsRestore(_caseFsDeps, ["stat"]);
afterEach(() => {
  _resetCaseFsCache();
});

let root: string;
/**
 * A second root with NO `.nax/` directory in it. On a case-insensitive volume
 * `realOrRaw(root/.NAX/config.json)` resolves the `.NAX` segment onto an
 * on-disk `.nax/`, which hands the exact-case spelling to every matcher and
 * makes the fold unobservable; a root without one leaves the candidate spelled
 * as the caller wrote it.
 */
let bareRoot: string;
beforeAll(() => {
  root = realpathSync(makeTempDir("nax-case-fold-"));
  // `resolveWithin` resolves through `realOrRaw`, so the directory must exist
  // for the resolved path to keep the root's canonical spelling.
  mkdirSync(join(root, ".nax", "mono", "api"), { recursive: true });
  bareRoot = realpathSync(makeTempDir("nax-case-fold-bare-"));
});
afterAll(() => {
  cleanupTempDir(root);
  cleanupTempDir(bareRoot);
});

const STATS = { dev: 7, ino: 42 };

/** A volume that folds case: every spelling of every path reaches the one inode. */
function stubCaseInsensitiveFs(): void {
  _caseFsDeps.stat = () => STATS;
}

/**
 * A volume that does not: only `root`'s own spelling (or one of its ancestors,
 * which the probe may pick as its target) resolves, so the case-swapped spelling
 * of the probe target throws ENOENT.
 */
function stubCaseSensitiveFs(): void {
  _caseFsDeps.stat = (path: string) => {
    if (path === root || root.startsWith(`${path}/`)) return STATS;
    throw Object.assign(new Error("ENOENT: stub"), { code: "ENOENT" });
  };
}

describe("foldCase on the segment matchers", () => {
  test("AC10: isNaxConfigSegments folds .nax, mono and config.json when asked to", () => {
    expect(isNaxConfigSegments([".NAX", "mono", "api", "CONFIG.JSON"], true)).toBe(true);
  });

  test("AC11: without foldCase every segment stays exact-case", () => {
    expect(isNaxConfigSegments([".NAX", "mono", "api", "CONFIG.JSON"])).toBe(false);
  });

  test("AC12: naxOwnedKind folds the feature PRD and the queue file when asked to", () => {
    expect(naxOwnedKind(".NAX/Features/x/PRD.JSON", true)).toBe("prd");
    expect(naxOwnedKind(".QUEUE.TXT", true)).toBe("queue");
  });

  test("AC13: without foldCase the case-variant spellings are not nax-owned", () => {
    expect(naxOwnedKind(".NAX/Features/x/PRD.JSON")).toBeUndefined();
  });
});

describe("naxOwnedPathsPolicy.bashRefusal on a case-insensitive volume", () => {
  test("AC14: a redirect into .NAX/config.json is refused", () => {
    stubCaseInsensitiveFs();
    expect(isCaseInsensitiveFs(root)).toBe(true);
    const refusal = naxOwnedPathsPolicy.bashRefusal(
      "Bash",
      ".NAX/config.json",
      [{ lexical: join(root, ".NAX", "config.json"), rel: ".NAX/config.json" }],
      { root, verb: "redirects into", sandboxWrapped: false },
    );
    expect(refusal).toContain("nax configuration");
  });

  test("AC15: a redirect into .nax/mono/api/CONFIG.JSON is refused", () => {
    stubCaseInsensitiveFs();
    const refusal = naxOwnedPathsPolicy.bashRefusal(
      "Bash",
      ".nax/mono/api/CONFIG.JSON",
      [{ lexical: join(root, ".nax", "mono", "api", "CONFIG.JSON"), rel: ".nax/mono/api/CONFIG.JSON" }],
      { root, verb: "redirects into", sandboxWrapped: false },
    );
    expect(refusal).toContain("nax configuration");
  });

  test("AC16: a redirect into .nax/features/x/PRD.JSON is refused", () => {
    stubCaseInsensitiveFs();
    const refusal = naxOwnedPathsPolicy.bashRefusal(
      "Bash",
      ".nax/features/x/PRD.JSON",
      [{ lexical: join(root, ".nax", "features", "x", "PRD.JSON"), rel: ".nax/features/x/PRD.JSON" }],
      { root, verb: "redirects into", sandboxWrapped: false },
    );
    expect(refusal).toContain("acceptance criteria");
  });

  test("AC17: on a case-sensitive volume the case-variant spelling is not nax's config", () => {
    stubCaseSensitiveFs();
    expect(isCaseInsensitiveFs(root)).toBe(false);
    expect(
      naxOwnedPathsPolicy.bashRefusal(
        "Bash",
        ".NAX/config.json",
        [{ lexical: join(root, ".NAX", "config.json"), rel: ".NAX/config.json" }],
        { root, verb: "redirects into", sandboxWrapped: false },
      ),
    ).toBeUndefined();
  });
});

describe("resolveWithin on a case-insensitive volume", () => {
  test("AC18: nax-agent's resolver refuses a case-variant config path", () => {
    stubCaseInsensitiveFs();
    expect(isCaseInsensitiveFs(root)).toBe(true);
    expect(resolveWithin(root, ".nax/mono/api/CONFIG.JSON", naxOwnedPathsPolicy)).toBeNull();
  });

  test("AC19: on a case-sensitive volume that same path resolves", () => {
    stubCaseSensitiveFs();
    expect(isCaseInsensitiveFs(root)).toBe(false);
    expect(resolveWithin(root, ".nax/mono/api/CONFIG.JSON", naxOwnedPathsPolicy)).toBe(
      join(root, ".nax", "mono", "api", "CONFIG.JSON"),
    );
  });
});

describe("createConfigReadGatePolicy on a case-insensitive volume", () => {
  test("AC20: a sandboxed read that only NAMES a case-variant config is allowed", () => {
    stubCaseInsensitiveFs();
    expect(isCaseInsensitiveFs(bareRoot)).toBe(true);
    const candidates = [{ lexical: join(bareRoot, ".NAX", "config.json"), rel: ".NAX/config.json" }];
    const ctx = { root: bareRoot, verb: "names" as const, sandboxWrapped: true };
    // The raw screen refuses it -- config is refused reads included -- so the
    // gate returning undefined below is the gate opening it, not a path that
    // nothing recognised.
    expect(naxOwnedPathsPolicy.bashRefusal("Bash", ".NAX/config.json", candidates, ctx)).toBeDefined();
    expect(
      createConfigReadGatePolicy(naxOwnedPathsPolicy, true).bashRefusal("Bash", ".NAX/config.json", candidates, ctx),
    ).toBeUndefined();
  });
});

// The typed-write path gets no root to probe, so it folds case unconditionally:
// on a case-sensitive volume this also refuses a stray `.QUEUE.TXT`, which is
// never nax's own file there -- refusing it costs nothing.
describe("naxOwnedWriteRefusal folds case without a probe", () => {
  test("AC21: a case-variant queue file is refused", () => {
    expect(naxOwnedWriteRefusal("Write", ".QUEUE.TXT")).toBeDefined();
  });

  test("AC22: a case-variant .nax path is refused as nax state", () => {
    expect(naxOwnedWriteRefusal("Write", ".NAX/config.json")).toContain("nax's own state");
  });

  test("AC23: the scratchpad stays writable through a case-variant prefix", () => {
    expect(naxOwnedWriteRefusal("Write", ".NAX/scratchpad/notes.md")).toBeUndefined();
  });
});
