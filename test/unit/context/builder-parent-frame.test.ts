/**
 * Builder repo-rooted path tests (single-frame PR 2).
 *
 * Before PR 2 the agent's file tools were contained at the package dir, so
 * declared paths were re-spelled into the package frame before being emitted
 * (nax#2067/#2089). The agent's tools are now rooted at the repo root, so
 * declared paths pass through as stored (repo-rooted) and are resolved against
 * the repo root. Package-frame partitioning is retired: a repo-rooted path is
 * reachable by construction, and a package's same-named file can no longer be
 * injected under a repo-rooted label.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { cleanupTempDir, makeConfigSlice, makePRD, makeSparseNaxConfig, makeStory, makeTempDir } from "@test/helpers";
import { _contextBuilderDeps, buildContext } from "@/context/builder";
import type { ContextBudget, StoryContext } from "@/context/types";
import type { PRD } from "@/prd";

/** Standard token budget for all tests. */
const BUDGET: ContextBudget = {
  maxTokens: 10000,
  reservedForInstructions: 1000,
  availableForContext: 9000,
};

const API_WORKDIR = "packages/api";

/** Write real files under `root` — the builder's `Bun.file().exists()` gate is real. */
async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [relPath, content] of Object.entries(files)) {
    const absPath = path.join(root, relPath);
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, content);
  }
}

/**
 * `workdir` here is the ABSOLUTE package dir for disk resolution; the story's
 * own `workdir` (repo-relative) is what the builder walks back to the repo root.
 */
function makeStoryContext(prd: PRD, absoluteWorkdir: string): StoryContext {
  return {
    prd,
    currentStoryId: "US-002",
    workdir: absoluteWorkdir,
    config: makeSparseNaxConfig({
      context: makeConfigSlice("context", {
        fileInjection: "disabled",
        testCoverage: { enabled: false },
      }),
    }),
  };
}

describe("context builder — repo-rooted parent outputs (single-frame PR 2)", () => {
  test("injects parent outputs repo-rooted, resolving them from the repo root", async () => {
    const tempDir = makeTempDir("nax-builder-frame-");
    try {
      await writeFiles(tempDir, {
        "package.json": JSON.stringify({ name: "repo-root-manifest" }),
        "packages/api/package.json": JSON.stringify({ name: "api-package-manifest" }),
        "packages/api/src/client.ts": "export const client = true;",
      });

      const parent = makeStory({
        id: "US-001",
        outputFiles: ["package.json", "packages/web/src/x.ts", "packages/api/src/client.ts"],
      });
      const consumer = makeStory({
        id: "US-002",
        dependencies: ["US-001"],
        workdir: API_WORKDIR,
        workdirSource: "stated",
      });
      const prd = makePRD({ userStories: [parent, consumer] });

      const built = await buildContext(makeStoryContext(prd, path.join(tempDir, API_WORKDIR)), BUDGET);
      const filePaths = built.elements.filter((e) => e.type === "file").map((e) => e.filePath);

      // Repo-rooted as stored: the root manifest and the parent's in-package output.
      expect(filePaths).toContain("package.json");
      expect(filePaths).toContain("packages/api/src/client.ts");
      // Declared but not created yet → passed through but absent on disk, so not emitted.
      expect(filePaths).not.toContain("packages/web/src/x.ts");
    } finally {
      cleanupTempDir(tempDir);
    }
  });

  test("never injects a package's same-named file under a repo-rooted path absent at the root", async () => {
    const tempDir = makeTempDir("nax-builder-frame-");
    try {
      // The parent's declared output "config/app.json" has NOT landed at the
      // repo root, and the consuming package happens to hold an UNRELATED file
      // at the same relative spelling. Because paths pass through repo-rooted
      // and resolve against the repo root, the package file is never reached —
      // there is no frame guessing to mislabel it as the parent's output.
      await writeFiles(tempDir, {
        "packages/api/config/app.json": JSON.stringify({ unrelated: true }),
        "packages/api/src/client.ts": "export const client = true;",
      });

      const parent = makeStory({ id: "US-001", outputFiles: ["config/app.json"] });
      const consumer = makeStory({
        id: "US-002",
        dependencies: ["US-001"],
        workdir: API_WORKDIR,
        workdirSource: "stated",
        contextFiles: ["packages/api/src/client.ts"],
      });
      const prd = makePRD({ userStories: [parent, consumer] });

      const built = await buildContext(makeStoryContext(prd, path.join(tempDir, API_WORKDIR)), BUDGET);
      const filePaths = built.elements.filter((e) => e.type === "file").map((e) => e.filePath);

      expect(filePaths).not.toContain("config/app.json");
      expect(filePaths).toContain("packages/api/src/client.ts");
    } finally {
      cleanupTempDir(tempDir);
    }
  });
});

describe("context builder — repo-rooted expectedFiles create-intent", () => {
  test("surfaces a declared-but-absent expectedFile as create-intent", async () => {
    const tempDir = makeTempDir("nax-builder-frame-");
    try {
      await writeFiles(tempDir, {
        "packages/api/src/existing.ts": "export const existing = true;",
      });

      const consumer = makeStory({
        id: "US-002",
        workdir: API_WORKDIR,
        workdirSource: "stated",
        expectedFiles: ["src/new.ts"],
      });
      const prd = makePRD({ userStories: [consumer] });

      const built = await buildContext(makeStoryContext(prd, path.join(tempDir, API_WORKDIR)), BUDGET);
      const createIntent = built.elements.find((e) => e.type === "file" && e.filePath === "src/new.ts");

      expect(createIntent).toBeDefined();
      expect(createIntent?.content).toContain("you will CREATE it");
    } finally {
      cleanupTempDir(tempDir);
    }
  });

  test("keeps a pre-#2067 story's create-intent expectedFile (no workdirSource)", async () => {
    const tempDir = makeTempDir("nax-builder-frame-");
    try {
      await writeFiles(tempDir, {
        "packages/api/src/existing.ts": "export const existing = true;",
      });

      const consumer = makeStory({
        id: "US-002",
        workdir: API_WORKDIR,
        expectedFiles: ["src/new.ts"],
      });
      const prd = makePRD({ userStories: [consumer] });

      const built = await buildContext(makeStoryContext(prd, path.join(tempDir, API_WORKDIR)), BUDGET);
      const createIntent = built.elements.find((e) => e.type === "file" && e.filePath === "src/new.ts");

      expect(createIntent).toBeDefined();
      expect(createIntent?.content).toContain("you will CREATE it");
    } finally {
      cleanupTempDir(tempDir);
    }
  });
});

describe("context builder — auto-detected contextFiles are repo-rooted (single-frame PR 2)", () => {
  let origAutoDetect: typeof _contextBuilderDeps.autoDetectContextFiles;

  beforeEach(() => {
    origAutoDetect = _contextBuilderDeps.autoDetectContextFiles;
  });

  afterEach(() => {
    _contextBuilderDeps.autoDetectContextFiles = origAutoDetect;
  });

  test("scans at the package dir but emits repo-rooted paths", async () => {
    const tempDir = makeTempDir("nax-builder-auto-detect-");
    try {
      await writeFiles(tempDir, {
        "packages/api/src/handler.ts": "export const handler = true;",
      });

      // Auto-detect output is relative to the workdir it is given. The scan
      // must stay PACKAGE-scoped (pre-PR discovery scope), and its
      // package-relative output must be re-spelled into the repo frame before
      // it is emitted/resolved.
      const seenWorkdirs: string[] = [];
      _contextBuilderDeps.autoDetectContextFiles = async (opts) => {
        seenWorkdirs.push(opts.workdir);
        return ["src/handler.ts"];
      };

      const consumer = makeStory({
        id: "US-002",
        workdir: API_WORKDIR,
        workdirSource: "stated",
      });
      const prd = makePRD({ userStories: [consumer] });

      const storyContext: StoryContext = {
        prd,
        currentStoryId: "US-002",
        workdir: path.join(tempDir, API_WORKDIR),
        config: makeSparseNaxConfig({
          context: makeConfigSlice("context", {
            fileInjection: "keyword",
            autoDetect: { enabled: true, maxFiles: 5, traceImports: false },
            testCoverage: { enabled: false },
          }),
        }),
      };

      const built = await buildContext(storyContext, BUDGET);
      const filePaths = built.elements.filter((e) => e.type === "file").map((e) => e.filePath);

      // Scan cwd is the ABSOLUTE package dir (discovery scope unchanged).
      expect(seenWorkdirs).toEqual([path.join(tempDir, API_WORKDIR)]);
      // Emitted path is re-spelled repo-rooted, and the package-relative
      // spelling is not emitted.
      expect(filePaths).toContain("packages/api/src/handler.ts");
      expect(filePaths).not.toContain("src/handler.ts");
    } finally {
      cleanupTempDir(tempDir);
    }
  });
});
