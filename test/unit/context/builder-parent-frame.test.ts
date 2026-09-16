/**
 * Builder frame-partition tests (nax#2089).
 *
 * A repo-root parent output (e.g. `package.json`) must not be re-spelled into
 * the consuming package and injected as if it were the file the parent touched:
 * `path.resolve(<pkg>, "package.json")` names a real but WRONG file. And because
 * the reframe preceded the `slice(0, FILE_INJECTION_MAX_FILES)`, each such path
 * also evicted a correct in-package file from the five available slots.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { cleanupTempDir, makeConfigSlice, makePRD, makeSparseNaxConfig, makeStory, makeTempDir } from "@test/helpers";
import { buildContext } from "@/context/builder";
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
});
