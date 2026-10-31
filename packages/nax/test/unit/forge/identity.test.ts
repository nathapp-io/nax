/**
 * Unit tests for the injected forge identity captured at CLI start (US-002).
 *
 * A leaked `_forgeIdentity.current` changes other suites' `botGit` argv, so
 * every test here resets it — and the injectable file delete — in `afterEach`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertNaxError, cleanupTempDir, makeTempDir } from "@test/helpers";
import { NaxError } from "@/errors";
import type { InjectedForgeIdentity } from "@/forge";
import {
  _forgeIdentity,
  _forgeIdentityDeps,
  captureForgeIdentity,
  FORGE_IDENTITY_ENV,
  injectedForgeIdentity,
} from "@/forge";

/** The token every forge-identity test uses. */
const TOKEN = "tok-7f3a9c";
const LOGIN = "acme-bot[bot]";

type Env = Record<string, string | undefined>;

let dir: string;
let originalDeleteFile: typeof _forgeIdentityDeps.deleteFile;

beforeEach(() => {
  dir = makeTempDir("nax-forge-identity-");
  originalDeleteFile = _forgeIdentityDeps.deleteFile;
  _forgeIdentity.current = undefined;
});

afterEach(() => {
  _forgeIdentityDeps.deleteFile = originalDeleteFile;
  _forgeIdentity.current = undefined;
  cleanupTempDir(dir);
});

/** Write a real token file into the per-test temp dir and return its path. */
function tokenFile(contents: string): string {
  const path = join(dir, "token");
  writeFileSync(path, contents);
  return path;
}

/** Await a rejection and narrow it to `NaxError`, failing when it resolved. */
async function rejection(env: Env): Promise<NaxError> {
  let caught: unknown;
  try {
    await captureForgeIdentity(env);
  } catch (err) {
    caught = err;
  }
  assertNaxError(caught, "captureForgeIdentity rejection");
  return caught;
}

function errnoError(code: string, message: string): Error {
  return Object.assign(new Error(`${code}: ${message}`), { code });
}

describe("captureForgeIdentity", () => {
  test("AC-1: resolves to undefined and leaves no captured identity when no forge input is present", async () => {
    const identity = await captureForgeIdentity({});

    expect(identity).toBeUndefined();
    expect(_forgeIdentity.current).toBeUndefined();
    expect(injectedForgeIdentity()).toBeUndefined();
  });

  test("AC-2: captures the trimmed token and login and exposes them through injectedForgeIdentity()", async () => {
    const identity = await captureForgeIdentity({
      [FORGE_IDENTITY_ENV.tokenFile]: tokenFile(`${TOKEN}\n`),
      [FORGE_IDENTITY_ENV.login]: LOGIN,
    });

    const expected: InjectedForgeIdentity = { token: TOKEN, login: LOGIN };
    expect(identity).toEqual(expected);
    expect(injectedForgeIdentity()).toEqual(expected);
  });

  test("AC-3: resolves the numeric user id", async () => {
    const identity = await captureForgeIdentity({
      [FORGE_IDENTITY_ENV.tokenFile]: tokenFile(`${TOKEN}\n`),
      [FORGE_IDENTITY_ENV.login]: LOGIN,
      [FORGE_IDENTITY_ENV.userId]: "42",
    });

    expect(identity?.id).toBe(42);
    expect(typeof identity?.id).toBe("number");
  });

  test("AC-4: a token file alone resolves the token with no login and no id", async () => {
    const identity = await captureForgeIdentity({
      [FORGE_IDENTITY_ENV.tokenFile]: tokenFile(`${TOKEN}\n`),
    });

    expect(identity).toEqual({ token: TOKEN });
    expect(Object.hasOwn(identity ?? {}, "login")).toBe(false);
    expect(Object.hasOwn(identity ?? {}, "id")).toBe(false);
  });

  test("AC-5: trims surrounding whitespace from the login", async () => {
    const identity = await captureForgeIdentity({
      [FORGE_IDENTITY_ENV.tokenFile]: tokenFile(`${TOKEN}\n`),
      [FORGE_IDENTITY_ENV.login]: `  ${LOGIN}\n`,
    });

    expect(identity?.login).toBe(LOGIN);
  });

  test("AC-6: the token file is gone once an identity is captured", async () => {
    const path = tokenFile(`${TOKEN}\n`);

    await captureForgeIdentity({ [FORGE_IDENTITY_ENV.tokenFile]: path, [FORGE_IDENTITY_ENV.login]: LOGIN });

    expect(existsSync(path)).toBe(false);
  });

  test("AC-7: rejects a token passed in the environment without leaking it into the message", async () => {
    const error = await rejection({ [FORGE_IDENTITY_ENV.rejectedToken]: TOKEN });

    expect(error.code).toBe("FORGE_IDENTITY_INVALID");
    expect(error.message).toContain("NAX_FORGE_TOKEN is not supported");
    expect(error.message).not.toContain(TOKEN);
  });

  test("AC-8: a blank token file path counts as absent, so the login requires one", async () => {
    const error = await rejection({
      [FORGE_IDENTITY_ENV.tokenFile]: "  ",
      [FORGE_IDENTITY_ENV.login]: LOGIN,
    });

    expect(error.message).toContain("NAX_FORGE_LOGIN requires NAX_FORGE_TOKEN_FILE");
  });

  test("AC-9: an id without a login is rejected", async () => {
    const error = await rejection({
      [FORGE_IDENTITY_ENV.tokenFile]: tokenFile(`${TOKEN}\n`),
      [FORGE_IDENTITY_ENV.userId]: "42",
    });

    expect(error.message).toContain("NAX_FORGE_USER_ID requires NAX_FORGE_LOGIN");
  });

  test("AC-10: rejects a non-numeric user id", async () => {
    const error = await rejection({
      [FORGE_IDENTITY_ENV.tokenFile]: tokenFile(`${TOKEN}\n`),
      [FORGE_IDENTITY_ENV.login]: LOGIN,
      [FORGE_IDENTITY_ENV.userId]: "4x",
    });

    expect(error.message).toContain("NAX_FORGE_USER_ID must be a positive integer");
  });

  test("AC-11: rejects a user id above Number.MAX_SAFE_INTEGER", async () => {
    const error = await rejection({
      [FORGE_IDENTITY_ENV.tokenFile]: tokenFile(`${TOKEN}\n`),
      [FORGE_IDENTITY_ENV.login]: LOGIN,
      [FORGE_IDENTITY_ENV.userId]: "9007199254740993",
    });

    expect(error.message).toContain("NAX_FORGE_USER_ID must be a positive integer");
  });

  test("AC-12: rejects a token file path that cannot be read", async () => {
    const error = await rejection({
      [FORGE_IDENTITY_ENV.tokenFile]: join(dir, "missing-token"),
      [FORGE_IDENTITY_ENV.login]: LOGIN,
    });

    expect(error.message).toContain("NAX_FORGE_TOKEN_FILE cannot be read");
  });

  test("AC-13: rejects a token file whose contents are only whitespace", async () => {
    const error = await rejection({
      [FORGE_IDENTITY_ENV.tokenFile]: tokenFile("  \n\t\n"),
      [FORGE_IDENTITY_ENV.login]: LOGIN,
    });

    expect(error.message).toContain("NAX_FORGE_TOKEN_FILE is empty");
  });

  test("AC-14: rejects an undeletable token file without leaking the token", async () => {
    _forgeIdentityDeps.deleteFile = async () => {
      throw errnoError("EACCES", "permission denied");
    };

    const error = await rejection({
      [FORGE_IDENTITY_ENV.tokenFile]: tokenFile(`${TOKEN}\n`),
      [FORGE_IDENTITY_ENV.login]: LOGIN,
    });

    expect(error.message).toContain("NAX_FORGE_TOKEN_FILE could not be deleted");
    expect(error.message).not.toContain(TOKEN);
  });

  test("AC-15: rejects an ambient token even with a valid token file, and still consumes the file", async () => {
    const path = tokenFile(`${TOKEN}\n`);

    const error = await rejection({
      [FORGE_IDENTITY_ENV.tokenFile]: path,
      [FORGE_IDENTITY_ENV.rejectedToken]: TOKEN,
      [FORGE_IDENTITY_ENV.login]: LOGIN,
    });

    expect(error.message).toContain("NAX_FORGE_TOKEN is not supported");
    expect(existsSync(path)).toBe(false);
  });

  test("AC-16: consumes the token file even when a later rule rejects the input", async () => {
    const path = tokenFile(`${TOKEN}\n`);

    const error = await rejection({
      [FORGE_IDENTITY_ENV.tokenFile]: path,
      [FORGE_IDENTITY_ENV.login]: LOGIN,
      [FORGE_IDENTITY_ENV.userId]: "4x",
    });

    expect(error.message).toContain("NAX_FORGE_USER_ID must be a positive integer");
    expect(existsSync(path)).toBe(false);
  });

  test("AC-17: a login without a token file is checked before the id", async () => {
    const error = await rejection({
      [FORGE_IDENTITY_ENV.login]: LOGIN,
      [FORGE_IDENTITY_ENV.userId]: "42",
    });

    expect(error.message).toContain("NAX_FORGE_LOGIN requires NAX_FORGE_TOKEN_FILE");
  });

  test("AC-18: an id without a token file is rejected", async () => {
    const error = await rejection({ [FORGE_IDENTITY_ENV.userId]: "42" });

    expect(error.message).toContain("NAX_FORGE_USER_ID requires NAX_FORGE_TOKEN_FILE");
  });

  test("AC-19: rejects a zero-padded user id", async () => {
    const error = await rejection({
      [FORGE_IDENTITY_ENV.tokenFile]: tokenFile(`${TOKEN}\n`),
      [FORGE_IDENTITY_ENV.login]: LOGIN,
      [FORGE_IDENTITY_ENV.userId]: "042",
    });

    expect(error.message).toContain("NAX_FORGE_USER_ID must be a positive integer");
  });

  test("AC-20: accepts the largest safe integer user id", async () => {
    const identity = await captureForgeIdentity({
      [FORGE_IDENTITY_ENV.tokenFile]: tokenFile(`${TOKEN}\n`),
      [FORGE_IDENTITY_ENV.login]: LOGIN,
      [FORGE_IDENTITY_ENV.userId]: "9007199254740991",
    });

    expect(identity?.id).toBe(9007199254740991);
  });

  test("AC-23: a rejection carries code FORGE_IDENTITY_INVALID and stage forge, without the token", async () => {
    const error = await rejection({
      [FORGE_IDENTITY_ENV.tokenFile]: tokenFile(`${TOKEN}\n`),
      [FORGE_IDENTITY_ENV.rejectedToken]: TOKEN,
    });

    expect(error).toBeInstanceOf(NaxError);
    expect(error.code).toBe("FORGE_IDENTITY_INVALID");
    expect(error.context).toEqual({ stage: "forge" });
    expect(error.message).not.toContain(TOKEN);
    expect(JSON.stringify(error.context)).not.toContain(TOKEN);
  });

  test("a delete that fails with ENOENT is not a failure: nothing is left on disk", async () => {
    _forgeIdentityDeps.deleteFile = async () => {
      throw errnoError("ENOENT", "no such file or directory");
    };

    const identity = await captureForgeIdentity({
      [FORGE_IDENTITY_ENV.tokenFile]: tokenFile(`${TOKEN}\n`),
      [FORGE_IDENTITY_ENV.login]: LOGIN,
    });

    expect(identity).toEqual({ token: TOKEN, login: LOGIN });
  });

  test("a rejected capture leaves no identity captured", async () => {
    await rejection({ [FORGE_IDENTITY_ENV.rejectedToken]: TOKEN });

    expect(_forgeIdentity.current).toBeUndefined();
    expect(injectedForgeIdentity()).toBeUndefined();
  });
});
