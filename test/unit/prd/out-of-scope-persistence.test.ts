/**
 * Disk round-trip for feature-level exclusions.
 *
 * `out-of-scope.test.ts` proves propagate/strip in memory. This file proves the
 * claim the JSDoc actually makes — that `loadPRD` denormalizes onto stories and
 * `savePRD` strips the mirrors back out, so `prd.json` keeps the root as SSOT
 * while in-memory stories (all the implementer and reviewers ever see) carry it.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadPRD, savePRD } from "@/prd";
import { makePRD, makeStory } from "@test/helpers";
import { withTempDir } from "@test/helpers";

const OUT_OF_SCOPE = ["An interactive Ink TUI", "Per-story checkpoints"];

async function writeAndLoad(dir: string, prd: ReturnType<typeof makePRD>) {
  const path = join(dir, "prd.json");
  await Bun.write(path, JSON.stringify(prd, null, 2));
  return { path, loaded: await loadPRD(path) };
}

describe("loadPRD / savePRD — outOfScope persistence", () => {
  test("loadPRD denormalizes the root list onto every story", async () => {
    await withTempDir(async (dir) => {
      const { loaded } = await writeAndLoad(
        dir,
        makePRD({
          outOfScope: OUT_OF_SCOPE,
          userStories: [makeStory({ id: "US-001" }), makeStory({ id: "US-002" })],
        }),
      );

      expect(loaded.outOfScope).toEqual(OUT_OF_SCOPE);
      expect(loaded.userStories.map((s) => s.outOfScope)).toEqual([OUT_OF_SCOPE, OUT_OF_SCOPE]);
    });
  });

  test("savePRD keeps the root as the only on-disk copy", async () => {
    await withTempDir(async (dir) => {
      const { path, loaded } = await writeAndLoad(
        dir,
        makePRD({ outOfScope: OUT_OF_SCOPE, userStories: [makeStory({ id: "US-001" })] }),
      );

      await savePRD(loaded, path);
      const onDisk = JSON.parse(await Bun.file(path).text());

      expect(onDisk.outOfScope).toEqual(OUT_OF_SCOPE);
      expect(onDisk.userStories[0].outOfScope).toBeUndefined();
    });
  });

  test("story-specific exclusions survive the save, feature-level mirrors do not", async () => {
    await withTempDir(async (dir) => {
      const { path, loaded } = await writeAndLoad(
        dir,
        makePRD({
          outOfScope: OUT_OF_SCOPE,
          userStories: [makeStory({ id: "US-001", outOfScope: ["no CLI wiring"] })],
        }),
      );

      expect(loaded.userStories[0].outOfScope).toEqual([...OUT_OF_SCOPE, "no CLI wiring"]);

      await savePRD(loaded, path);
      const onDisk = JSON.parse(await Bun.file(path).text());
      expect(onDisk.userStories[0].outOfScope).toEqual(["no CLI wiring"]);
    });
  });

  test("repeated load/save cycles do not accumulate or lose entries", async () => {
    await withTempDir(async (dir) => {
      const { path } = await writeAndLoad(
        dir,
        makePRD({
          outOfScope: OUT_OF_SCOPE,
          userStories: [makeStory({ id: "US-001", outOfScope: ["no CLI wiring"] })],
        }),
      );

      for (let i = 0; i < 3; i++) {
        const prd = await loadPRD(path);
        await savePRD(prd, path);
      }

      const onDisk = JSON.parse(await Bun.file(path).text());
      expect(onDisk.outOfScope).toEqual(OUT_OF_SCOPE);
      expect(onDisk.userStories[0].outOfScope).toEqual(["no CLI wiring"]);
    });
  });

  test("a story entry duplicating a feature-level one is absorbed into the root", async () => {
    // Not byte-identical, but the story's *effective* set is unchanged: the next
    // load re-propagates it. Documented on stripPropagatedOutOfScope.
    await withTempDir(async (dir) => {
      const { path, loaded } = await writeAndLoad(
        dir,
        makePRD({
          outOfScope: OUT_OF_SCOPE,
          userStories: [makeStory({ id: "US-001", outOfScope: [OUT_OF_SCOPE[0]] })],
        }),
      );

      await savePRD(loaded, path);
      const onDisk = JSON.parse(await Bun.file(path).text());
      expect(onDisk.userStories[0].outOfScope).toBeUndefined();

      const reloaded = await loadPRD(path);
      expect(reloaded.userStories[0].outOfScope).toEqual(OUT_OF_SCOPE);
    });
  });

  test("a PRD with no exclusions round-trips without gaining the key", async () => {
    await withTempDir(async (dir) => {
      const { path, loaded } = await writeAndLoad(dir, makePRD({ userStories: [makeStory({ id: "US-001" })] }));

      expect(loaded.userStories[0].outOfScope).toBeUndefined();
      await savePRD(loaded, path);
      const onDisk = JSON.parse(await Bun.file(path).text());
      expect(onDisk.outOfScope).toBeUndefined();
      expect(onDisk.userStories[0].outOfScope).toBeUndefined();
    });
  });
});
