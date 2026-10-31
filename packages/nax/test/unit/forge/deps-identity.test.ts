/**
 * `defaultRun` and `defaultForgeDeps` under an injected identity (US-003).
 *
 * The token must reach `gh` / `glab` and nothing else. Every case spawns a real
 * `#!/bin/sh` fixture in a temp dir and asserts on its stdout, so the assertion
 * is about the environment the child actually received — not about how nax
 * computed it. The identity is captured through `captureForgeIdentity`, which
 * is what the CLI entry does, so the capture-to-transport wiring is covered.
 *
 * `_forgeIdentity.current` and the three token variables are restored in
 * `afterEach`: a leaked identity would change other suites' spawn environments.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { _forgeIdentity, captureForgeIdentity, defaultForgeDeps, FORGE_IDENTITY_ENV } from "@/forge";
import { defaultRun } from "@/forge/deps";

/** The token every forge-identity test uses. */
const TOKEN = "tok-7f3a9c";
const LOGIN = "acme-bot[bot]";

/** The variables a forge CLI reads a token from; none may leak from the ambient env into an assertion. */
const TOKEN_VARS = ["GH_TOKEN", "GH_ENTERPRISE_TOKEN", "GITLAB_TOKEN"] as const;

let dir: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  dir = makeTempDir("nax-forge-deps-identity-");
  _forgeIdentity.current = undefined;
  for (const name of TOKEN_VARS) {
    savedEnv[name] = process.env[name];
    delete process.env[name];
  }
});

afterEach(() => {
  _forgeIdentity.current = undefined;
  for (const name of TOKEN_VARS) {
    const value = savedEnv[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  cleanupTempDir(dir);
});

/** Write an executable `#!/bin/sh` fixture into the per-test temp dir and return its path. */
function fixture(name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

/** Capture an identity the way `bin/nax.ts` does: a real token file read and deleted. */
async function captureIdentity(login: string | undefined): Promise<void> {
  const path = join(dir, "token");
  writeFileSync(path, `${TOKEN}\n`);
  await captureForgeIdentity({
    [FORGE_IDENTITY_ENV.tokenFile]: path,
    ...(login === undefined ? {} : { [FORGE_IDENTITY_ENV.login]: login }),
  });
}

describe("defaultForgeDeps.identity", () => {
  test("AC-13 returns the value held in _forgeIdentity.current", () => {
    expect(defaultForgeDeps.identity?.()).toBeUndefined();

    const identity = { token: TOKEN, login: LOGIN };
    _forgeIdentity.current = identity;

    expect(defaultForgeDeps.identity?.()).toBe(identity);
  });

  test("returns what captureForgeIdentity captured", async () => {
    await captureIdentity(LOGIN);

    expect(defaultForgeDeps.identity?.()).toEqual({ token: TOKEN, login: LOGIN });
  });
});

describe("defaultRun with a captured identity", () => {
  test("AC-14 gh reads the token from GH_TOKEN", async () => {
    await captureIdentity(LOGIN);
    const gh = fixture("gh", "printf '%s' \"$GH_TOKEN\"");

    expect(await defaultRun([gh], { cwd: dir })).toEqual({ exitCode: 0, stdout: TOKEN, stderr: "" });
  });

  test("AC-15 gh also gets GH_ENTERPRISE_TOKEN, which GitHub Enterprise Server reads", async () => {
    await captureIdentity(LOGIN);
    const gh = fixture("gh", "printf '%s' \"$GH_ENTERPRISE_TOKEN\"");

    expect(await defaultRun([gh], { cwd: dir })).toEqual({ exitCode: 0, stdout: TOKEN, stderr: "" });
  });

  test("AC-16 glab reads the token from GITLAB_TOKEN", async () => {
    await captureIdentity(LOGIN);
    const glab = fixture("glab", "printf '%s' \"$GITLAB_TOKEN\"");

    expect(await defaultRun([glab], { cwd: dir })).toEqual({ exitCode: 0, stdout: TOKEN, stderr: "" });
  });

  test("AC-17 any other program receives no token", async () => {
    await captureIdentity(LOGIN);
    const other = fixture("other", "printf '%s' \"$GH_TOKEN$GITLAB_TOKEN\"");

    const result = await defaultRun([other], { cwd: dir });

    expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    expect(result.stdout).not.toBe(TOKEN);
    expect(result.stdout).not.toContain(TOKEN);
  });

  test("AC-18 the token is never added to the command line", async () => {
    await captureIdentity(LOGIN);
    const gh = fixture("gh", "printf '%s' \"$*\"");

    expect(await defaultRun([gh, "api", "user"], { cwd: dir })).toEqual({
      exitCode: 0,
      stdout: "api user",
      stderr: "",
    });
  });
});

describe("defaultRun without an identity", () => {
  test("AC-19 keeps the ambient environment: no token is injected", async () => {
    const gh = fixture("gh", "printf '%s' \"$GH_TOKEN\"");

    const result = await defaultRun([gh], { cwd: dir });

    expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
  });

  test("AC-20 a gh or glab that rejects the token reports that failure once, without retrying", async () => {
    await captureIdentity(LOGIN);
    const cases = [
      ["gh", "GH_TOKEN"],
      ["glab", "GITLAB_TOKEN"],
    ] as const;

    for (const [program, tokenVar] of cases) {
      const counter = join(dir, `${program}-invocations`);
      const rejecting = fixture(
        program,
        `printf 'x' >> '${counter}'\nif [ -n "$${tokenVar}" ]; then\n  printf '%s' "authentication failed" >&2\n  exit 1\nfi\nprintf '%s' "no token"`,
      );

      const result = await defaultRun([rejecting], { cwd: dir });

      expect(result).toEqual({ exitCode: 1, stdout: "", stderr: "authentication failed" });
      expect(readFileSync(counter, "utf8")).toBe("x");
    }
  });
});
