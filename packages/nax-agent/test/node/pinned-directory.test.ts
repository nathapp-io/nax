import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { _atomicWriteDeps, writeFileAtomic } from "#src/internal/atomic-write";
import { withPinnedDirectory } from "#src/internal/pinned-directory";

test("real Node stages, publishes and removes relative to the pinned parent after replacement", async () => {
  expect(process.versions.bun).toBeUndefined();
  const dir = await mkdtemp(join(tmpdir(), "nax-node-pinned-"));
  const path = join(dir, "notes");
  const aside = join(dir, "aside");
  try {
    await mkdir(path);
    await withPinnedDirectory(
      { path, identity: await stat(path), changed: () => new Error("directory changed") },
      async () => {
        await rename(path, aside);
        await mkdir(path);
        await writeFile(join(path, "note"), "replacement");
        await writeFileAtomic(join(path, "note"), "original");
        expect(await readFile(join(aside, "note"), "utf8")).toBe("original");
        await _atomicWriteDeps.rm(join(path, "note"), { force: true });
        expect(await readFile(join(path, "note"), "utf8")).toBe("replacement");
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
