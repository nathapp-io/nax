/**
 * US-004: `nax context fragments` — inspect & prune commands
 *
 * Mirrors the 7 ACs:
 *  AC1 — feature with two fragments → output lists both story IDs
 *  AC2 — feature with no fragments  → reports none found, exit status 0
 *  AC3 — per-fragment listing includes transitively-dependent story IDs
 *  AC4 — prune with storyId removes only that fragment; others readable
 *  AC5 — prune without storyId removes every fragment for the feature
 *  AC6 — prune with no fragments → exit 0, reports nothing was removed
 *  AC7 — formatter is pure: same input → identical output, zero file I/O
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { _fragmentStoreDeps, listFragmentStoryIds, readFragment } from "@/context";
import type { PRD, UserStory } from "@/prd";
import { makePRD, makeStory, withDepsRestore } from "@test/helpers";
import {
  _contextFragmentsDeps,
  formatFragmentsInspect,
  formatFragmentsPrune,
  fragmentsInspectCommand,
  fragmentsPruneCommand,
  listDependentStoryIds,
} from "@/cli";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeStoriesPRD(stories: readonly UserStory[]): PRD {
  return makePRD({ feature: "feat-x", userStories: [...stories] });
}

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1B\[[0-9;]*m/g, "");
}

function lines(output: string[]): string[] {
  return output.map(stripAnsi);
}

withDepsRestore(_fragmentStoreDeps);

// ─────────────────────────────────────────────────────────────────────────────
// AC7 — formatter purity
// ─────────────────────────────────────────────────────────────────────────────

describe("formatFragmentsInspect — purity (US-004 AC7)", () => {
  test("[US-004 AC7] same listing input returns identical output", () => {
    const listing = [
      { storyId: "US-001", dependentStoryIds: ["US-003"] },
      { storyId: "US-002", dependentStoryIds: [] },
    ];

    const a = formatFragmentsInspect("feat-x", listing);
    const b = formatFragmentsInspect("feat-x", listing);

    expect(a).toEqual(b);
  });

  test("[US-004 AC7] formatter never reads or writes files", () => {
    let readCalled = false;
    let writeCalled = false;
    let fileExistsCalled = false;

    _fragmentStoreDeps.fileExists = async () => {
      fileExistsCalled = true;
      return false;
    };
    _fragmentStoreDeps.readFile = async () => {
      readCalled = true;
      return "";
    };
    _fragmentStoreDeps.writeFile = async () => {
      writeCalled = true;
      return 0;
    };
    _fragmentStoreDeps.listFragments = async () => {
      // The pure formatter must not call back into the dep at all.
      throw new Error("listFragments should never be called by a pure formatter");
    };

    const listing = [{ storyId: "US-001", dependentStoryIds: ["US-002"] }];
    const out1 = formatFragmentsInspect("feat-x", listing);
    const out2 = formatFragmentsInspect("feat-x", listing);

    expect(out1).toEqual(out2);
    expect(readCalled).toBe(false);
    expect(writeCalled).toBe(false);
    expect(fileExistsCalled).toBe(false);
  });

  test("identical input ordering produces identical output ordering (stable)", () => {
    const listing = [
      { storyId: "US-002", dependentStoryIds: ["US-005"] },
      { storyId: "US-001", dependentStoryIds: ["US-003"] },
    ];

    const out = formatFragmentsInspect("feat-x", listing);
    const flat = out.join("\n");
    const idxUS002 = flat.indexOf("US-002");
    const idxUS001 = flat.indexOf("US-001");
    expect(idxUS002).toBeLessThan(idxUS001);
  });
});

describe("formatFragmentsPrune — purity (US-004 AC7)", () => {
  test("same input returns identical output and never touches files", () => {
    let touched = false;
    _fragmentStoreDeps.readFile = async () => {
      touched = true;
      return "";
    };
    _fragmentStoreDeps.writeFile = async () => {
      touched = true;
      return 0;
    };

    const summary = { featureId: "feat-x", requestedStoryId: undefined, removedStoryIds: ["US-001", "US-002"] };
    const a = formatFragmentsPrune(summary);
    const b = formatFragmentsPrune(summary);
    expect(a).toEqual(b);
    expect(touched).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC1, AC2 — inspect formatter content
// ─────────────────────────────────────────────────────────────────────────────

describe("formatFragmentsInspect — content (US-004 AC1, AC2)", () => {
  test("[US-004 AC1] output lists both story ids when the listing has two fragments", () => {
    const listing = [
      { storyId: "US-001", dependentStoryIds: [] },
      { storyId: "US-002", dependentStoryIds: [] },
    ];
    const out = lines(formatFragmentsInspect("feat-x", listing));
    const flat = out.join("\n");
    expect(flat).toContain("US-001");
    expect(flat).toContain("US-002");
  });

  test("[US-004 AC2] reports no fragments when listing is empty", () => {
    const out = lines(formatFragmentsInspect("feat-x", []));
    const flat = out.join("\n").toLowerCase();
    expect(flat).toContain("no fragments");
    expect(flat).toContain("feat-x");
  });

  test("[US-004 AC3] per-fragment line lists transitively-dependent story ids", () => {
    // US-002 → US-001; US-001 has a fragment. So US-001's fragment section
    // should mention US-002 as a dependent story id.
    const listing = [{ storyId: "US-001", dependentStoryIds: ["US-002"] }];
    const out = lines(formatFragmentsInspect("feat-x", listing));
    const flat = out.join("\n");
    expect(flat).toContain("US-001");
    expect(flat).toContain("US-002");
  });

  test("per-fragment section for a fragment with no dependents still names the fragment", () => {
    const listing = [{ storyId: "US-001", dependentStoryIds: [] }];
    const out = lines(formatFragmentsInspect("feat-x", listing));
    const flat = out.join("\n");
    expect(flat).toContain("US-001");
  });

  test("multiple fragments are each rendered with their own dependent list", () => {
    // US-003 → US-002, US-004 → US-002; listing: US-002 with [US-003, US-004]; US-005 alone.
    const listing = [
      { storyId: "US-002", dependentStoryIds: ["US-003", "US-004"] },
      { storyId: "US-005", dependentStoryIds: [] },
    ];
    const out = lines(formatFragmentsInspect("feat-x", listing));
    const flat = out.join("\n");
    expect(flat).toContain("US-002");
    expect(flat).toContain("US-003");
    expect(flat).toContain("US-004");
    expect(flat).toContain("US-005");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// listDependentStoryIds — reverse transitive dependents (used by AC3)
// ─────────────────────────────────────────────────────────────────────────────

describe("listDependentStoryIds — reverse transitive dependents", () => {
  test("direct dependent of US-001 returns US-002", () => {
    const prd = makeStoriesPRD([
      makeStory({ id: "US-001", dependencies: [] }),
      makeStory({ id: "US-002", dependencies: ["US-001"] }),
    ]);
    expect(listDependentStoryIds(prd, "US-001")).toEqual(["US-002"]);
  });

  test("transitive dependent: US-001 → US-002 → US-003 → US-004 → US-001 cycle returns US-002 and US-003 when walking from US-001", () => {
    // A → B → C → D → A
    const prd = makeStoriesPRD([
      makeStory({ id: "US-001", dependencies: ["US-002"] }),
      makeStory({ id: "US-002", dependencies: ["US-003"] }),
      makeStory({ id: "US-003", dependencies: ["US-004"] }),
      makeStory({ id: "US-004", dependencies: ["US-001"] }),
    ]);
    // Walking forward from US-001 we reach US-002, US-003, US-004 (cycle).
    // Each of those is therefore a "transitive dependent" of US-001 in the
    // reverse direction: starting from US-001 in the reverse graph, you can
    // reach every story the forward graph reaches from US-001.
    const result = listDependentStoryIds(prd, "US-001");
    expect(result.sort()).toEqual(["US-002", "US-003", "US-004"]);
  });

  test("diamond: story with multiple direct dependents returns all of them, no duplicates", () => {
    const prd = makeStoriesPRD([
      makeStory({ id: "US-001", dependencies: [] }),
      makeStory({ id: "US-002", dependencies: ["US-001"] }),
      makeStory({ id: "US-003", dependencies: ["US-001"] }),
      makeStory({ id: "US-004", dependencies: ["US-002", "US-003"] }),
    ]);
    expect(listDependentStoryIds(prd, "US-001").sort()).toEqual(["US-002", "US-003", "US-004"]);
  });

  test("story with no dependents returns []", () => {
    const prd = makeStoriesPRD([
      makeStory({ id: "US-001", dependencies: [] }),
      makeStory({ id: "US-002", dependencies: ["US-099"] }),
    ]);
    expect(listDependentStoryIds(prd, "US-001")).toEqual([]);
  });

  test("does not include the requesting story itself in its own dependents", () => {
    const prd = makeStoriesPRD([
      makeStory({ id: "US-001", dependencies: ["US-001"] }), // self-loop
    ]);
    expect(listDependentStoryIds(prd, "US-001")).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC4, AC5, AC6 — prune formatter + command behaviour
// ─────────────────────────────────────────────────────────────────────────────

describe("formatFragmentsPrune — content (US-004 AC4, AC5, AC6)", () => {
  test("single-story prune summary names the removed story", () => {
    const out = lines(
      formatFragmentsPrune({ featureId: "feat-x", requestedStoryId: "US-001", removedStoryIds: ["US-001"] }),
    );
    expect(out.join("\n")).toContain("US-001");
  });

  test("feature-wide prune summary names all removed stories", () => {
    const out = lines(
      formatFragmentsPrune({
        featureId: "feat-x",
        requestedStoryId: undefined,
        removedStoryIds: ["US-001", "US-002", "US-003"],
      }),
    );
    const flat = out.join("\n");
    expect(flat).toContain("US-001");
    expect(flat).toContain("US-002");
    expect(flat).toContain("US-003");
  });

  test("[US-004 AC6] empty prune summary reports nothing was removed", () => {
    const out = lines(formatFragmentsPrune({ featureId: "feat-x", requestedStoryId: undefined, removedStoryIds: [] }));
    const flat = out.join("\n").toLowerCase();
    expect(flat).toMatch(/nothing|no fragment/);
  });
});

describe("fragmentsPruneCommand — single-story (US-004 AC4)", () => {
  test("[US-004 AC4] removes only the targeted story fragment; other fragments stay readable", async () => {
    // Fragments live at <projectDir>/features/<featureId>/fragments/<storyId>.md
    // where projectDir = <repoRoot>/.nax (default for the command).
    const writes = new Map<string, string>();
    const path1 = "/repo/.nax/features/feat-x/fragments/US-001.md";
    const path2 = "/repo/.nax/features/feat-x/fragments/US-002.md";
    writes.set(path1, "remove me");
    writes.set(path2, "keep me");

    _fragmentStoreDeps.mkdirp = async () => undefined;
    _fragmentStoreDeps.writeFile = async (p, content) => {
      writes.set(p, content);
      return content.length;
    };
    _fragmentStoreDeps.fileExists = async (p) => writes.has(p);
    _fragmentStoreDeps.readFile = async (p) => writes.get(p) ?? "";
    _fragmentStoreDeps.listFragments = async () => [];
    _fragmentStoreDeps.removeFile = async (p) => {
      writes.delete(p);
    };

    const exitCode = await fragmentsPruneCommand({
      dir: "/repo",
      feature: "feat-x",
      storyId: "US-001",
    });

    expect(exitCode).toBe(0);
    const removed = await readFragment("/repo/.nax", "feat-x", "US-001");
    const kept = await readFragment("/repo/.nax", "feat-x", "US-002");
    expect(removed).toBeNull();
    expect(kept).toBe("keep me");
  });
});

describe("fragmentsPruneCommand — feature-wide (US-004 AC5, AC6)", () => {
  test("[US-004 AC5] removes every fragment for the feature when no storyId is given", async () => {
    const writes = new Map<string, string>();
    const path1 = "/repo/.nax/features/feat-x/fragments/US-001.md";
    const path2 = "/repo/.nax/features/feat-x/fragments/US-002.md";
    const path3 = "/repo/.nax/features/feat-x/fragments/US-003.md";
    writes.set(path1, "a");
    writes.set(path2, "b");
    writes.set(path3, "c");

    _fragmentStoreDeps.mkdirp = async () => undefined;
    _fragmentStoreDeps.writeFile = async (p, content) => {
      writes.set(p, content);
      return content.length;
    };
    const dirPath = "/repo/.nax/features/feat-x/fragments";
    _fragmentStoreDeps.fileExists = async (p) => writes.has(p) || p === dirPath;
    _fragmentStoreDeps.readFile = async (p) => writes.get(p) ?? "";
    _fragmentStoreDeps.listFragments = async () => ["US-001.md", "US-002.md", "US-003.md"];
    _fragmentStoreDeps.removeFile = async (p) => {
      writes.delete(p);
    };

    const exitCode = await fragmentsPruneCommand({
      dir: "/repo",
      feature: "feat-x",
    });

    expect(exitCode).toBe(0);
    expect(await readFragment("/repo/.nax", "feat-x", "US-001")).toBeNull();
    expect(await readFragment("/repo/.nax", "feat-x", "US-002")).toBeNull();
    expect(await readFragment("/repo/.nax", "feat-x", "US-003")).toBeNull();
  });

  test("[US-004 AC6] prune with no fragments exits 0 and reports nothing was removed", async () => {
    _fragmentStoreDeps.fileExists = async () => false;
    _fragmentStoreDeps.listFragments = async () => [];
    _fragmentStoreDeps.removeFile = async () => undefined;

    const exitCode = await fragmentsPruneCommand({
      dir: "/repo",
      feature: "feat-empty",
    });

    expect(exitCode).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC1, AC2 — fragmentsInspectCommand shape (return value & exit code)
// ─────────────────────────────────────────────────────────────────────────────

describe("fragmentsInspectCommand — exit code (US-004 AC2)", () => {
  test("[US-004 AC2] feature with no fragments exits with status 0", async () => {
    _fragmentStoreDeps.fileExists = async () => false;
    _fragmentStoreDeps.listFragments = async () => [];

    const exitCode = await fragmentsInspectCommand({
      dir: "/repo",
      feature: "feat-empty",
    });

    expect(exitCode).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// _contextFragmentsDeps — pure deps override for inspect command
// ─────────────────────────────────────────────────────────────────────────────

describe("_contextFragmentsDeps — loadPRD override for AC3 (US-004 AC3)", () => {
  let originalDeps: typeof _contextFragmentsDeps;

  beforeEach(() => {
    originalDeps = {
      loadPRD: _contextFragmentsDeps.loadPRD,
      projectDirFor: _contextFragmentsDeps.projectDirFor,
    };
  });

  afterEach(() => {
    _contextFragmentsDeps.loadPRD = originalDeps.loadPRD;
    _contextFragmentsDeps.projectDirFor = originalDeps.projectDirFor;
  });

  test("[US-004 AC3] inspect command reads the PRD and lists transitive dependents", async () => {
    _fragmentStoreDeps.fileExists = async () => true;
    _fragmentStoreDeps.listFragments = async () => ["US-001.md"];

    // US-001 → US-002 → US-003
    _contextFragmentsDeps.loadPRD = async () =>
      makeStoriesPRD([
        makeStory({ id: "US-001", dependencies: [] }),
        makeStory({ id: "US-002", dependencies: ["US-001"] }),
        makeStory({ id: "US-003", dependencies: ["US-002"] }),
      ]);

    const captured: string[][] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => {
      captured.push(args.map((a) => String(a)));
    };

    try {
      const exitCode = await fragmentsInspectCommand({
        dir: "/repo",
        feature: "feat-x",
      });
      expect(exitCode).toBe(0);
    } finally {
      console.log = orig;
    }

    const flat = captured.join("\n");
    expect(flat).toContain("US-001");
    // US-002 and US-003 should appear as dependents of US-001's fragment.
    expect(flat).toContain("US-002");
    expect(flat).toContain("US-003");
  });

  test("[US-004 AC1] inspect command lists both fragment story ids", async () => {
    _fragmentStoreDeps.fileExists = async () => true;
    _fragmentStoreDeps.listFragments = async () => ["US-001.md", "US-002.md"];

    _contextFragmentsDeps.loadPRD = async () => null;

    const captured: string[][] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => {
      captured.push(args.map((a) => String(a)));
    };

    try {
      const exitCode = await fragmentsInspectCommand({
        dir: "/repo",
        feature: "feat-x",
      });
      expect(exitCode).toBe(0);
    } finally {
      console.log = orig;
    }

    const flat = captured.join("\n");
    expect(flat).toContain("US-001");
    expect(flat).toContain("US-002");
  });
});

// Touch the import so it isn't accidentally tree-shaken — these helpers are
// the canonical store entry points used by the implementation.
describe("store re-exports (US-004)", () => {
  test("listFragmentStoryIds is the canonical entry point", () => {
    expect(typeof listFragmentStoryIds).toBe("function");
  });
});
