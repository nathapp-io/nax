/**
 * M8: with `.env` git-ignored and a committed symlink `docs/notes.txt -> ../.env`, an `@`
 * mention of the symlink used to attach the secret, because the ignore check asked git about
 * the typed path only. A fake git cannot prove the real `check-ignore` invocation resolves the
 * target, so this runs the shipped commands against a real checkout.
 */
import { expect, test } from "bun:test";
import { mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { withTempDir } from "@test/helpers";
import * as chat from "@/chat";
import { expandChatMentions } from "@/chat";

const originalDeps = { ...chat._mentionExpandDeps };
/** The secret's only content: no record may carry it through a symlink. */
const SECRET_LINE = "SECRET_TOKEN=test";
/** An empty template dir: a sandboxed agent cannot read the system template directory. */
const INIT_ARGS = ["-c", "init.templateDir=", "init", "-q"];
/** A commit must not depend on the machine's git identity or signing configuration. */
const COMMIT_CONFIG = ["-c", "user.name=nax", "-c", "user.email=nax@example.com", "-c", "commit.gpgsign=false"];

/** Write the fixture: an ignored `.env`, and a symlink to it the repo would carry. */
async function writeFixture(root: string): Promise<void> {
  await Bun.write(join(root, ".gitignore"), ".env\n");
  await Bun.write(join(root, ".env"), `${SECRET_LINE}\n`);
  await mkdir(join(root, "docs"));
  await symlink("../.env", join(root, "docs/notes.txt"));
}

/** Commit what git will take: the ignore file and the symlink, never the ignored `.env`. */
async function commitFixture(root: string): Promise<void> {
  const add = await originalDeps.git([...COMMIT_CONFIG, "add", "-A"], root);
  expect(add.exitCode).toBe(0);
  const commit = await originalDeps.git([...COMMIT_CONFIG, "commit", "-q", "-m", "fixture"], root);
  expect(commit.exitCode).toBe(0);
}

test("AC-6 refuses a committed symlink whose target is a git-ignored .env", async () => {
  await withTempDir(async (root) => {
    const init = await originalDeps.git(INIT_ARGS, root);
    expect(init.exitCode).toBe(0);
    await writeFixture(root);
    await commitFixture(root);
    Object.assign(chat._mentionExpandDeps, originalDeps);
    const result = await expandChatMentions("see @docs/notes.txt", { cwd: root, repoRoot: root });
    expect(result.records).toEqual([
      { path: "docs/notes.txt", status: "refused", note: "not attached: ignored by git", body: "" },
    ]);
    expect(result.message).not.toContain(SECRET_LINE);
  });
});
