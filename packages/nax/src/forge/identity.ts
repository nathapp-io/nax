/**
 * The forge identity nax is told to act as, captured once at CLI start.
 *
 * The caller passes a token through a file (`NAX_FORGE_TOKEN_FILE`) rather than
 * the environment because a token in nax's environment reaches everything nax
 * spawns. `captureForgeIdentity` reads and deletes that file before any command
 * runs, so a run never holds the token on disk, and rejects the environment
 * routes (`NAX_FORGE_TOKEN`) that cannot be hidden from child processes.
 *
 * Validation order is the contract: every rule is checked in the order the
 * brief states, and the first failure decides the message. The token file is
 * consumed first so that no later rejection leaves it on disk.
 *
 * State is process-local and read through `injectedForgeIdentity()`; US-003
 * (forge calls) and US-004 (`botGit`) consume it. Nothing here spawns.
 */

import { NaxError } from "@/errors";

/** Code carried by every startup refusal from this module. */
const FORGE_IDENTITY_INVALID = "FORGE_IDENTITY_INVALID";

/** `NAX_FORGE_USER_ID` is a bare positive integer — no sign, no padding, no exponent. */
const USER_ID_PATTERN = /^[1-9][0-9]*$/;

/** The identity captured from the environment; absent when nothing was injected. */
export interface InjectedForgeIdentity {
  readonly token: string;
  readonly login?: string;
  readonly id?: number;
}

export const FORGE_IDENTITY_ENV = {
  tokenFile: "NAX_FORGE_TOKEN_FILE",
  login: "NAX_FORGE_LOGIN",
  userId: "NAX_FORGE_USER_ID",
  /** Never accepted: an environment token is inherited by every child process. */
  rejectedToken: "NAX_FORGE_TOKEN",
} as const;

/** Mutable holder in the `_deps` style; tests set it and must reset it to undefined in afterEach. */
export const _forgeIdentity: { current: InjectedForgeIdentity | undefined } = { current: undefined };

/** Injectable file delete; the default is `(path) => Bun.file(path).delete()`. */
export const _forgeIdentityDeps: { deleteFile(path: string): Promise<void> } = {
  deleteFile(path: string): Promise<void> {
    return Bun.file(path).delete();
  },
};

/** The identity captured at CLI start, or undefined when nothing was injected. */
export function injectedForgeIdentity(): InjectedForgeIdentity | undefined {
  return _forgeIdentity.current;
}

/** Outcome of reading the token file, kept as a union so "failed" cannot carry contents. */
type TokenFileContents = { readonly readFailed: true } | { readonly readFailed: false; readonly token: string };

/** A trimmed, present value — an unset or whitespace-only variable counts as absent. */
function present(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

function invalid(reason: string): NaxError {
  return new NaxError(`[forge] Invalid injected forge identity: ${reason}`, FORGE_IDENTITY_INVALID, {
    stage: "forge",
  });
}

function isErrnoCode(err: unknown, code: string): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === code;
}

/**
 * Read then delete the token file — deletion happens even when the read failed,
 * so nax never runs with the token still on disk. A delete that finds nothing
 * (ENOENT) is not a failure; any other delete error is.
 */
async function consumeTokenFile(path: string): Promise<TokenFileContents> {
  // A missing/unreadable file is reported by rule 7, after the cheaper input
  // rules — so the failure is recorded here rather than thrown.
  const raw = await Bun.file(path)
    .text()
    .catch(() => undefined);
  try {
    await _forgeIdentityDeps.deleteFile(path);
  } catch (err) {
    if (!isErrnoCode(err, "ENOENT")) {
      throw invalid(`${FORGE_IDENTITY_ENV.tokenFile} could not be deleted`);
    }
  }
  return raw === undefined ? { readFailed: true } : { readFailed: false, token: raw.trim() };
}

/** Rule 4–6: the login/id pairing and the id format. Returns the parsed id. */
function validateAccount(
  tokenFile: string | undefined,
  login: string | undefined,
  userId: string | undefined,
): number | undefined {
  if (tokenFile === undefined) {
    if (login !== undefined) {
      throw invalid(`${FORGE_IDENTITY_ENV.login} requires ${FORGE_IDENTITY_ENV.tokenFile}`);
    }
    if (userId !== undefined) {
      throw invalid(`${FORGE_IDENTITY_ENV.userId} requires ${FORGE_IDENTITY_ENV.tokenFile}`);
    }
  }
  if (userId !== undefined && login === undefined) {
    throw invalid(`${FORGE_IDENTITY_ENV.userId} requires ${FORGE_IDENTITY_ENV.login}`);
  }
  if (userId === undefined) return undefined;
  const id = Number(userId);
  if (!USER_ID_PATTERN.test(userId) || id > Number.MAX_SAFE_INTEGER) {
    throw invalid(`${FORGE_IDENTITY_ENV.userId} must be a positive integer`);
  }
  return id;
}

/** Rule 7: the token file, once every cheaper input rule has passed. */
function tokenFrom(contents: TokenFileContents | undefined): string {
  if (contents === undefined || contents.readFailed) {
    throw invalid(`${FORGE_IDENTITY_ENV.tokenFile} cannot be read`);
  }
  if (!contents.token) throw invalid(`${FORGE_IDENTITY_ENV.tokenFile} is empty`);
  return contents.token;
}

/**
 * Apply the input rules to `env`, read and delete the token file, store the
 * result in `_forgeIdentity.current`. Resolves to the identity or undefined;
 * rejects with a NaxError code FORGE_IDENTITY_INVALID.
 */
export async function captureForgeIdentity(
  env: Record<string, string | undefined>,
): Promise<InjectedForgeIdentity | undefined> {
  // A refused capture must not leave a previously captured identity in place.
  _forgeIdentity.current = undefined;

  const tokenFile = present(env[FORGE_IDENTITY_ENV.tokenFile]);
  const login = present(env[FORGE_IDENTITY_ENV.login]);
  const userId = present(env[FORGE_IDENTITY_ENV.userId]);

  // Rule 1 first: whatever the rest of the input says, the file is consumed.
  const contents = tokenFile === undefined ? undefined : await consumeTokenFile(tokenFile);

  if (present(env[FORGE_IDENTITY_ENV.rejectedToken]) !== undefined) {
    throw invalid(
      `${FORGE_IDENTITY_ENV.rejectedToken} is not supported; pass the token through ${FORGE_IDENTITY_ENV.tokenFile}`,
    );
  }

  // Rule 3: nothing injected — behaviour is exactly as before this feature.
  if (tokenFile === undefined && login === undefined && userId === undefined) return undefined;

  const id = validateAccount(tokenFile, login, userId);
  const identity: InjectedForgeIdentity = {
    token: tokenFrom(contents),
    ...(login === undefined ? {} : { login }),
    ...(id === undefined ? {} : { id }),
  };
  _forgeIdentity.current = identity;
  return identity;
}
