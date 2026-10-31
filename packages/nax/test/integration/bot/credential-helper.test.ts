/**
 * The bot credential helper as real git runs it (US-004).
 *
 * Two independent proofs, both local — no forge is contacted:
 *
 *  1. `git credential fill` in a temporary repository, with the helper installed
 *     exactly as `botGit` installs it (`-c credential.helper=` then
 *     `-c credential.helper=<helper>`), so the pair is proven to answer git and
 *     the empty entry is proven to clear a configured helper.
 *  2. The helper string alone through `sh -c`, which is the harness git itself
 *     uses: it strips the leading `!` and appends the action as an argument.
 *
 * Git is spawned with the machine's own configuration disabled
 * (`GIT_CONFIG_GLOBAL` / `GIT_CONFIG_SYSTEM`), so a developer's credential helper
 * can neither answer for us nor mask a broken one.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { NAX_BOT_CREDENTIAL_HELPER } from "@/bot";

const TOKEN = "tok-7f3a9c";
const TOKEN_KEY = "NAX_FORGE_GIT_TOKEN";
const HTTPS_INPUT = "protocol=https\nhost=github.com\n\n";
/** What the injected credential answers; `x-access-token` is the GitHub App HTTPS username. */
const USERNAME_LINE = "username=x-access-token";
const PASSWORD_LINE = `password=${TOKEN}`;

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

let dir: string;

beforeEach(() => {
  dir = makeTempDir("nax-bot-credential-");
});

afterEach(() => {
  cleanupTempDir(dir);
});

/** The ambient environment with any inherited forge state removed and git config isolated. */
function gitEnv(overrides: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("NAX_FORGE_")) continue;
    if (value !== undefined) env[key] = value;
  }
  // `/dev/null` is git's documented "ignore this config file" value.
  return { ...env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", ...overrides };
}

/** Run a command to completion, feeding `input` on stdin. */
async function run(argv: string[], input: string, env: Record<string, string>, cwd: string): Promise<RunResult> {
  const proc = Bun.spawn(argv, {
    cwd,
    env,
    stdin: new TextEncoder().encode(input),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

/** A fresh temporary git repository, so a local `credential.helper` cannot leak between cases. */
async function makeRepo(name: string): Promise<string> {
  const repo = join(dir, name);
  const result = await run(["git", "init", "-q", repo], "", gitEnv(), dir);
  expect(result.exitCode).toBe(0);
  return repo;
}

/** The exact argv `botGit` builds for an authenticated fetch or push, up to the subcommand. */
const FILL_ARGV = [
  "git",
  "-c",
  "credential.helper=",
  "-c",
  `credential.helper=${NAX_BOT_CREDENTIAL_HELPER}`,
  "credential",
  "fill",
];

/** git's own harness for a `!`-prefixed helper: the string minus `!`, then the action, under `sh -c`. */
function harnessCommand(action: string): string {
  return `${NAX_BOT_CREDENTIAL_HELPER.replace(/^!/, "")} ${action}`;
}

function harness(action: string, input: string): Promise<RunResult> {
  return run(["sh", "-c", harnessCommand(action)], input, gitEnv({ [TOKEN_KEY]: TOKEN }), dir);
}

describe("bot credential helper under real git", () => {
  test("AC-8 credential fill answers the injected username and token over HTTPS", async () => {
    const repo = await makeRepo("https");

    const result = await run(FILL_ARGV, HTTPS_INPUT, gitEnv({ [TOKEN_KEY]: TOKEN }), repo);

    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(USERNAME_LINE);
    expect(result.stdout).toContain(PASSWORD_LINE);
  });

  test("AC-9 the empty helper entry clears a repository-local helper that would answer wrong", async () => {
    const repo = await makeRepo("local-helper");
    const configure = await run(
      ["git", "config", "credential.helper", "!f() { printf '%s\\n' 'password=wrong'; }; f"],
      "",
      gitEnv(),
      repo,
    );
    expect(configure.exitCode).toBe(0);

    const result = await run(FILL_ARGV, HTTPS_INPUT, gitEnv({ [TOKEN_KEY]: TOKEN }), repo);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(PASSWORD_LINE);
    expect(result.stdout).not.toContain("password=wrong");
  });

  test("AC-10 the helper answers get for https with the username and token", async () => {
    const result = await harness("get", HTTPS_INPUT);

    expect(NAX_BOT_CREDENTIAL_HELPER.startsWith("!")).toBe(true);
    expect(NAX_BOT_CREDENTIAL_HELPER).not.toContain(TOKEN);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(USERNAME_LINE);
    expect(result.stdout).toContain(PASSWORD_LINE);
  });

  test("AC-11 the helper stays silent for a non-HTTPS protocol", async () => {
    const result = await harness("get", "protocol=http\nhost=example.com\n\n");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });

  test("AC-12 the helper never stores a credential", async () => {
    const result = await harness("store", HTTPS_INPUT);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });

  test("AC-13 the helper never erases a credential", async () => {
    const result = await harness("erase", HTTPS_INPUT);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });
});
