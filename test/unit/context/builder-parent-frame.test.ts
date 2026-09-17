/**
 * Builder frame-partition tests (nax#2089).
 *
 * A repo-root parent output (e.g. `package.json`) must not be re-spelled into
 * the consuming package and injected as if it were the file the parent touched:
 * `path.resolve(<pkg>, "package.json")` names a real but WRONG file. And because
 * the reframe preceded the `slice(0, FILE_INJECTION_MAX_FILES)`, each such path
 * also evicted a correct in-package file from the five available slots.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import {
  cleanupTempDir,
  makeConfigSlice,
  makeLogger,
  makePRD,
  makeSparseNaxConfig,
  makeStory,
  makeTempDir,
} from "@test/helpers";
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
 * `workdir` here is the ABSOLUTE package dir for resolve/exists; the story's own
 * `workdir` (repo-relative) plus `workdirSource` drives the frame conversion.
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

describe("context builder parent-frame partitioning (nax#2089)", () => {
  test("drops a repo-root parent output instead of injecting the package's same-named file", async () => {
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
      const fileElements = built.elements.filter((e) => e.type === "file");

      // (1) #2081's in-package fix must stay green.
      expect(fileElements.map((e) => e.filePath)).toContain("src/client.ts");
      // (2) The repo-root manifest must NOT be re-spelled to the package's own
      //     package.json — that path resolves to a real but WRONG file.
      expect(fileElements.some((e) => e.filePath === "package.json")).toBe(false);
    } finally {
      cleanupTempDir(tempDir);
    }
  });

  test("unreachable parent paths do not consume file-injection slots", async () => {
    const tempDir = makeTempDir("nax-builder-frame-");
    try {
      await writeFiles(tempDir, {
        "package.json": JSON.stringify({ name: "repo-root-manifest" }),
        "packages/api/package.json": JSON.stringify({ name: "api-package-manifest" }),
        "packages/api/src/a.ts": "export const a = true;",
        "packages/api/src/b.ts": "export const b = true;",
        "packages/api/src/c.ts": "export const c = true;",
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
        contextFiles: ["packages/api/src/a.ts", "packages/api/src/b.ts", "packages/api/src/c.ts"],
      });
      const prd = makePRD({ userStories: [parent, consumer] });

      const built = await buildContext(makeStoryContext(prd, path.join(tempDir, API_WORKDIR)), BUDGET);
      const filePaths = built.elements.filter((e) => e.type === "file").map((e) => e.filePath);

      // Every injected file is in-package (package-relative under src/).
      expect(filePaths.every((p) => p?.startsWith("src/") === true)).toBe(true);
      // The in-package parent output survives slot eviction.
      expect(filePaths).toContain("src/client.ts");
    } finally {
      cleanupTempDir(tempDir);
    }
  });

  test("keeps a canonical story's create-intent expectedFile in the package frame", async () => {
    const tempDir = makeTempDir("nax-builder-frame-");
    try {
      // `src/new.ts` is intentionally NOT on disk: it is this story's own
      // to-be-created output, authored workdir-relative. The write seam only
      // re-spells paths that resolved on disk, so it stays package-relative.
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

// ─────────────────────────────────────────────────────────────────────────────
// path-frame follow-up: H4, H5, M16 — the canonical drop over-reaches
// ─────────────────────────────────────────────────────────────────────────────

describe("context builder — BLOCKER 1: merged parent outputs are never reclassified by provenance-blind probing", () => {
  test("a parent output absent at the repo root is NOT reclassified to an unrelated same-named package file", async () => {
    const tempDir = makeTempDir("nax-builder-frame-blocker1-");
    try {
      // The parent's declared output "config/app.json" has NOT landed at the
      // repo root (story skipped/failed/not yet run) -- nothing is written
      // there. The consuming package happens to contain an UNRELATED file at
      // the same relative spelling. Reclassifying by "exists at package,
      // does not exist at repo root" alone re-spells this into
      // "packages/api/config/app.json" and injects it labelled as the
      // parent's output -- a real but WRONG file, exactly the #2089 failure
      // mode reached from the other direction. Provenance (own declared vs.
      // merged parent output) is the only safe discriminator: outputFiles is
      // not guaranteed repo-rooted (Ruling 8/E), so this entry's frame is
      // simply unknown and must not be guessed.
      await writeFiles(tempDir, {
        "packages/api/config/app.json": JSON.stringify({ unrelated: true }),
        "packages/api/src/client.ts": "export const client = true;",
      });

      const parent = makeStory({
        id: "US-001",
        outputFiles: ["config/app.json"],
      });
      const consumer = makeStory({
        id: "US-002",
        dependencies: ["US-001"],
        workdir: API_WORKDIR,
        workdirSource: "stated",
        contextFiles: ["src/client.ts"],
      });
      const prd = makePRD({ userStories: [parent, consumer] });

      const built = await buildContext(makeStoryContext(prd, path.join(tempDir, API_WORKDIR)), BUDGET);
      const filePaths = built.elements.filter((e) => e.type === "file").map((e) => e.filePath);

      // The unrelated package file must NOT be injected under the parent's label.
      expect(filePaths).not.toContain("config/app.json");
      // The story's own declared file is unaffected.
      expect(filePaths).toContain("src/client.ts");
    } finally {
      cleanupTempDir(tempDir);
    }
  });
});

describe("context builder — H4: reclassify a plan-time-absent contextFiles entry", () => {
  test("a contextFiles entry that exists ONLY inside the package (not at the repo root) is injected, not dropped", async () => {
    const tempDir = makeTempDir("nax-builder-frame-h4-");
    try {
      // `canonicalizeDeclaredPath` (src/prd/workdir-canonical.ts) leaves a
      // declared path unchanged when it did not resolve on disk AT PLAN TIME.
      // This story's own write-seam pass never re-spelled "src/gen.ts" because
      // nothing existed at either frame back then — an EARLIER STORY IN THIS
      // RUN has since created it under the package. At consumption time
      // (now) it exists ONLY at packages/api/src/gen.ts, never at the repo
      // root, so the reclassification is unambiguous.
      await writeFiles(tempDir, {
        "packages/api/src/gen.ts": "export const generated = true;",
      });

      const consumer = makeStory({
        id: "US-002",
        workdir: API_WORKDIR,
        workdirSource: "stated",
        contextFiles: ["src/gen.ts"],
      });
      const prd = makePRD({ userStories: [consumer] });

      const built = await buildContext(makeStoryContext(prd, path.join(tempDir, API_WORKDIR)), BUDGET);
      const filePaths = built.elements.filter((e) => e.type === "file").map((e) => e.filePath);

      expect(filePaths).toContain("src/gen.ts");
    } finally {
      cleanupTempDir(tempDir);
    }
  });
});

describe("context builder — H5: auto-detected contextFiles are never canonically dropped", () => {
  let origAutoDetect: typeof _contextBuilderDeps.autoDetectContextFiles;

  beforeEach(() => {
    origAutoDetect = _contextBuilderDeps.autoDetectContextFiles;
  });

  afterEach(() => {
    _contextBuilderDeps.autoDetectContextFiles = origAutoDetect;
  });

  test("a canonical story (workdirSource stamped) under keyword fileInjection still surfaces auto-detected files", async () => {
    const tempDir = makeTempDir("nax-builder-frame-h5-");
    try {
      await writeFiles(tempDir, {
        "packages/api/src/handler.ts": "export const handler = true;",
      });

      // autoDetectContextFiles runs `git grep` at the ABSOLUTE package dir
      // (src/context/auto-detect.ts), so its output is PACKAGE-RELATIVE by
      // construction — never repo-rooted, regardless of what the story's
      // workdirSource says. Mocked here rather than exercised via real git
      // grep: the point under test is the FRAME the builder treats this set
      // as, not auto-detect's own keyword matching.
      _contextBuilderDeps.autoDetectContextFiles = async () => ["src/handler.ts"];

      // Canonical story: workdirSource IS stamped. Before this fix, this set
      // took `canonical: true` unconditionally on this basis, and
      // partitionPackageFrame's repo-rooted assumption dropped every
      // auto-detected entry as "outside the package" — the feature silently
      // no-op'd for every canonical monorepo story under keyword injection.
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

      expect(filePaths).toContain("src/handler.ts");
    } finally {
      cleanupTempDir(tempDir);
    }
  });
});

describe("context builder — M16: the canonical drop is logged", () => {
  let origLogger: typeof _contextBuilderDeps.getLogger;

  beforeEach(() => {
    origLogger = _contextBuilderDeps.getLogger;
  });

  afterEach(() => {
    _contextBuilderDeps.getLogger = origLogger;
  });

  test("warns once with a count and the workdir/packageDir fields when entries are dropped", async () => {
    const tempDir = makeTempDir("nax-builder-frame-m16-");
    try {
      // Nothing on disk at either frame for "package.json" or
      // "packages/web/src/x.ts" — both stay genuinely unreachable from the
      // "packages/api" consumer and must be dropped.
      await writeFiles(tempDir, {
        "packages/api/src/client.ts": "export const client = true;",
      });

      const logger = makeLogger();
      _contextBuilderDeps.getLogger = () => logger;

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

      await buildContext(makeStoryContext(prd, path.join(tempDir, API_WORKDIR)), BUDGET);

      const dropWarnings = logger.calls.filter(
        (c) =>
          c.level === "warn" &&
          c.message === "Context files could not be resolved inside this story's package and were dropped",
      );
      expect(dropWarnings).toHaveLength(1);
      const data = dropWarnings[0]?.data;
      expect(data?.storyId).toBe("US-002");
      expect(data?.count).toBe(2);
      // M-3: vocabulary per .nax/rules/monorepo-awareness.md §"Path Variable
      // Vocabulary" -- packageDir is ABSOLUTE, story.workdir (logged as
      // `workdir`) is RELATIVE. These two assertions were previously swapped.
      expect(data?.packageDir).toBe(path.join(tempDir, API_WORKDIR));
      expect(data?.workdir).toBe(API_WORKDIR);
    } finally {
      cleanupTempDir(tempDir);
    }
  });
});
