/**
 * Credential injection for bot network git calls (US-004).
 *
 * Every case captures the identity through `captureForgeIdentity` — the seam the
 * CLI uses — and then observes the real spawn, so an argv-only assertion cannot
 * pass while the token never reaches the spawned process's environment. The
 * token must stay out of argv entirely: argv is visible in `ps` and in git's own
 * error output, while the environment is not written to `.git/config`.
 *
 * `_forgeIdentity.current` leaks into every other suite that spawns through
 * `botGit`, so it is reset after each case.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeSpawn, makeTempDir } from "@test/helpers";
import { _fixInputDeps, botGit, checkPushAccess, NAX_BOT_CREDENTIAL_HELPER } from "@/bot";
import { _forgeIdentity, captureForgeIdentity } from "@/forge";
import { _gitDeps } from "@/utils/git";

/** The token every forge-identity test uses. */
const TOKEN = "tok-7f3a9c";
const LOGIN = "acme-bot[bot]";
/** The variable git's credential helper reads; never passed in argv. */
const TOKEN_KEY = "NAX_FORGE_GIT_TOKEN";
const NO_PROMPT_KEY = "GIT_TERMINAL_PROMPT";

const PUSH = ["push", "origin", "HEAD:refs/heads/x"];

/** Hooks stay off on every argv; an authenticated verb adds the credential pair after it. */
const HOOKS_OFF_ARGV = ["git", "-c", "core.hooksPath=/dev/null"];
const CREDENTIAL_ARGV = [
  "git",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "credential.helper=",
  "-c",
  `credential.helper=${NAX_BOT_CREDENTIAL_HELPER}`,
];

let dir: string;
let originalSpawn: typeof _gitDeps.spawn;

beforeEach(() => {
  dir = makeTempDir("nax-bot-git-identity-");
  originalSpawn = _gitDeps.spawn;
  _forgeIdentity.current = undefined;
});

afterEach(() => {
  _gitDeps.spawn = originalSpawn;
  _forgeIdentity.current = undefined;
  cleanupTempDir(dir);
});

/** Capture the identity exactly as `bin/nax.ts` does: from a real token file. */
async function captureIdentity(): Promise<void> {
  const path = join(dir, "forge-token");
  writeFileSync(path, `${TOKEN}\n`);
  await captureForgeIdentity({ NAX_FORGE_TOKEN_FILE: path, NAX_FORGE_LOGIN: LOGIN });
}

/** Observe the spawn rather than the value `botGit` decided to pass on. */
function stubSpawn() {
  const spawn = makeSpawn();
  _gitDeps.spawn = spawn.spawn;
  return spawn;
}

describe("botGit credential injection", () => {
  test("AC-1 push carries the helper prefix ahead of the original arguments", async () => {
    await captureIdentity();
    const spawn = stubSpawn();

    await botGit(PUSH, "/repo");

    expect(spawn.calls).toHaveLength(1);
    expect(spawn.calls[0]?.cmd).toEqual([...CREDENTIAL_ARGV, ...PUSH]);
  });

  test("AC-2 the spawned push process receives the token in its environment", async () => {
    await captureIdentity();
    const spawn = stubSpawn();

    await botGit(PUSH, "/repo");

    expect(spawn.lastEnv()[TOKEN_KEY]).toBe(TOKEN);
  });

  test("AC-3 fetch carries the same prefix and the token in its environment", async () => {
    await captureIdentity();
    const spawn = stubSpawn();

    await botGit(["fetch", "origin"], "/repo");

    expect(spawn.calls[0]?.cmd).toEqual([...CREDENTIAL_ARGV, "fetch", "origin"]);
    expect(spawn.lastEnv()[TOKEN_KEY]).toBe(TOKEN);
  });

  test("AC-4 the token never appears in an argv element", async () => {
    await captureIdentity();
    const spawn = stubSpawn();

    await botGit(PUSH, "/repo");
    await botGit(["fetch", "origin"], "/repo");

    expect(spawn.calls).toHaveLength(2);
    for (const call of spawn.calls) {
      expect(call.cmd.filter((arg) => arg.includes(TOKEN))).toEqual([]);
    }
  });

  test("AC-5 a non-network verb keeps the plain argv and no token", async () => {
    await captureIdentity();
    const spawn = stubSpawn();

    await botGit(["rev-parse", "HEAD"], "/repo");

    expect(spawn.calls[0]?.cmd).toEqual([...HOOKS_OFF_ARGV, "rev-parse", "HEAD"]);
    expect(TOKEN_KEY in spawn.lastEnv()).toBe(false);
  });

  test("AC-6 with no identity captured a push is unchanged", async () => {
    const spawn = stubSpawn();

    await botGit(PUSH, "/repo");

    expect(spawn.calls[0]?.cmd).toEqual([...HOOKS_OFF_ARGV, ...PUSH]);
  });

  test("AC-7 checkPushAccess reaches git through botGit with the credential prefix", async () => {
    await captureIdentity();
    const spawn = stubSpawn();

    const outcome = await checkPushAccess("/repo", "x");

    // The probe must be authenticated by the same path as the real push, not by a
    // caller that re-implements the prefix — so the seam is left at its default.
    expect(_fixInputDeps.runGit).toBe(botGit);
    expect(outcome).toEqual({ ok: true });
    const cmd = spawn.calls[0]?.cmd ?? [];
    expect(cmd.slice(0, CREDENTIAL_ARGV.length)).toEqual(CREDENTIAL_ARGV);
    expect(cmd).toContain("--dry-run");
    expect(spawn.lastEnv()[TOKEN_KEY]).toBe(TOKEN);
  });

  test("AC-14 a rejected credential fails instead of prompting", async () => {
    await captureIdentity();
    const spawn = stubSpawn();

    await botGit(PUSH, "/repo");

    expect(spawn.lastEnv()[NO_PROMPT_KEY]).toBe("0");
  });

  test("AC-15 a rejected token surfaces git's failure once, with no retry and no fallback", async () => {
    await captureIdentity();
    const spawn = makeSpawn(() => ({ exitCode: 1, stderr: "authentication failed" }));
    _gitDeps.spawn = spawn.spawn;

    expect(await botGit(PUSH, "/repo")).toEqual({
      stdout: "",
      stderr: "authentication failed",
      exitCode: 1,
    });
    expect(spawn.calls).toHaveLength(1);
  });
});
