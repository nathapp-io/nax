/**
 * US-001: the per-folder trust store (`src/trust/store.ts`).
 *
 * The store is global -- `<globalConfigDir>/trust.json`, honouring
 * `NAX_GLOBAL_CONFIG_DIR` -- and is read and written under
 * `withPathFileLock`. Two properties the tests pin down that a naive
 * implementation gets wrong:
 *
 *  - `addTrustEntry` must `mkdir` the global config directory BEFORE taking the
 *    lock (the `wx` lock rethrows ENOENT otherwise), so a first-ever run with
 *    no `~/.nax` still succeeds (AC15).
 *  - an unreadable store makes both writes fail closed with
 *    `TRUST_STORE_UNREADABLE` and leaves the bytes on disk untouched, rather
 *    than silently starting from an empty store (AC17, AC21).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { assertDefined, assertNaxError, cleanupTempDir, loadTrustModule, makeTempDir, trustFn } from "@test/helpers";
import { NaxError } from "@/errors";
import type { TrustEntry, TrustStoreFile } from "@/trust";
import { byCodePoint } from "@/utils/sort";

const trust = await loadTrustModule();

const ADDED_AT = "2026-09-30T00:00:00.000Z";

let globalDir: string;
let workdir: string;
let savedGlobalEnv: string | undefined;
let savedNow: (() => Date) | undefined;

beforeEach(() => {
  // The ACs compare normalized paths, and macOS temp dirs sit under a symlinked
  // /var, so every temp directory is referred to by its realpath.
  globalDir = realpathSync(makeTempDir("nax-trust-global-"));
  workdir = realpathSync(makeTempDir("nax-trust-work-"));
  savedGlobalEnv = process.env.NAX_GLOBAL_CONFIG_DIR;
  process.env.NAX_GLOBAL_CONFIG_DIR = globalDir;
});

afterEach(() => {
  cleanupTempDir(globalDir);
  cleanupTempDir(workdir);
  if (savedGlobalEnv === undefined) {
    delete process.env.NAX_GLOBAL_CONFIG_DIR;
  } else {
    process.env.NAX_GLOBAL_CONFIG_DIR = savedGlobalEnv;
  }
  const deps = trust._trustStoreDeps;
  if (deps && savedNow) {
    deps.now = savedNow;
    savedNow = undefined;
  }
});

/** `<globalConfigDir>/trust.json` for the directory the test currently points at. */
function storePath(): string {
  return join(process.env.NAX_GLOBAL_CONFIG_DIR ?? "", "trust.json");
}

/** Overwrite the store with `folders`, creating the global directory. */
function writeStore(folders: TrustStoreFile["folders"]): void {
  mkdirSync(globalDir, { recursive: true });
  writeFileSync(storePath(), JSON.stringify({ version: 1, folders }));
}

/** Read the store back as its parsed shape. */
function readStore(): TrustStoreFile {
  return JSON.parse(readFileSync(storePath(), "utf8")) as TrustStoreFile;
}

/** Freeze the store's clock at `iso` for the current test. */
function setNow(iso: string): void {
  const deps = trust._trustStoreDeps;
  assertDefined(deps, "_trustStoreDeps");
  savedNow = deps.now;
  deps.now = () => new Date(iso);
}

describe("resolveTrustRoot", () => {
  test("AC7: returns the project root when an ancestor holds .nax/config.json", () => {
    const resolveTrustRoot = trustFn(trust, "resolveTrustRoot");
    mkdirSync(join(workdir, ".nax"), { recursive: true });
    mkdirSync(join(workdir, "src", "deep"), { recursive: true });
    writeFileSync(join(workdir, ".nax", "config.json"), "{}");

    expect(resolveTrustRoot(join(workdir, "src", "deep"))).toBe(workdir);
  });

  test("AC8: returns resolve(workdir) when neither it nor any ancestor holds .nax/config.json", () => {
    const resolveTrustRoot = trustFn(trust, "resolveTrustRoot");
    const dir = join(workdir, "no-config", "deeper");
    mkdirSync(dir, { recursive: true });

    expect(resolveTrustRoot(dir)).toBe(resolve(dir));
  });

  test("AC9: ignores the global config when the only .nax/config.json on the walk is the global one", () => {
    const resolveTrustRoot = trustFn(trust, "resolveTrustRoot");
    const home = join(workdir, "home");
    mkdirSync(join(home, ".nax"), { recursive: true });
    mkdirSync(join(home, "x"), { recursive: true });
    writeFileSync(join(home, ".nax", "config.json"), "{}");
    process.env.NAX_GLOBAL_CONFIG_DIR = join(home, ".nax");

    expect(resolveTrustRoot(join(home, "x"))).toBe(resolve(join(home, "x")));
  });
});

describe("readTrustStore", () => {
  test("AC10: returns { state: 'missing' } when trust.json is absent", async () => {
    const readTrustStore = trustFn(trust, "readTrustStore");

    expect(await readTrustStore()).toEqual({ state: "missing" });
  });

  test("AC10 boundary: returns state 'ok' with the parsed file when trust.json is valid", async () => {
    const readTrustStore = trustFn(trust, "readTrustStore");
    writeStore([{ path: workdir, addedAt: ADDED_AT, via: "cli" }]);

    const read = await readTrustStore();

    expect(read.state === "ok" ? read.file : null).toEqual({
      version: 1,
      folders: [{ path: workdir, addedAt: ADDED_AT, via: "cli" }],
    });
  });

  test("AC11: returns state 'unparseable' when trust.json is not JSON", async () => {
    const readTrustStore = trustFn(trust, "readTrustStore");
    mkdirSync(globalDir, { recursive: true });
    writeFileSync(storePath(), "{not json");

    expect((await readTrustStore()).state).toBe("unparseable");
  });

  test("AC12: returns state 'unparseable' when the store declares an unknown version", async () => {
    const readTrustStore = trustFn(trust, "readTrustStore");
    mkdirSync(globalDir, { recursive: true });
    writeFileSync(storePath(), JSON.stringify({ version: 2, folders: [] }));

    expect((await readTrustStore()).state).toBe("unparseable");
  });
});

describe("addTrustEntry", () => {
  test("AC13: writes a version-1 entry stamped by _trustStoreDeps.now once the store is empty", async () => {
    const addTrustEntry = trustFn(trust, "addTrustEntry");
    setNow(ADDED_AT);

    const result = await addTrustEntry(workdir, "cli");

    expect(result.outcome).toBe("added");
    expect(result.outcome === "added" ? result.entry : null).toEqual({
      path: workdir,
      addedAt: ADDED_AT,
      via: "cli",
    });
    expect(readStore()).toEqual({
      version: 1,
      folders: [{ path: workdir, addedAt: ADDED_AT, via: "cli" }],
    });
  });

  test("AC14: writes the store file with permission bits 0o600", async () => {
    const addTrustEntry = trustFn(trust, "addTrustEntry");

    await addTrustEntry(workdir, "cli");

    expect(statSync(storePath()).mode & 0o777).toBe(0o600);
  });

  test("AC15: creates the global config directory when it does not exist", async () => {
    const addTrustEntry = trustFn(trust, "addTrustEntry");
    const missingGlobal = join(globalDir, "missing", "nested");
    process.env.NAX_GLOBAL_CONFIG_DIR = missingGlobal;

    const result = await addTrustEntry(workdir, "cli");

    expect(result.outcome).toBe("added");
    expect(existsSync(join(missingGlobal, "trust.json"))).toBe(true);
  });

  test("AC16: reports 'already-covered' without writing when an ancestor of the path is trusted", async () => {
    const addTrustEntry = trustFn(trust, "addTrustEntry");
    writeStore([{ path: workdir, addedAt: ADDED_AT, via: "cli" }]);
    const before = readFileSync(storePath());

    const result = await addTrustEntry(join(workdir, "child"), "cli");

    expect(result.outcome).toBe("already-covered");
    expect(result.outcome === "already-covered" ? result.coveredBy.path : null).toBe(workdir);
    expect(readFileSync(storePath()).equals(before)).toBe(true);
  });

  test("AC17: rejects with TRUST_STORE_UNREADABLE and leaves an unparseable store untouched", async () => {
    const addTrustEntry = trustFn(trust, "addTrustEntry");
    mkdirSync(globalDir, { recursive: true });
    writeFileSync(storePath(), "{not json");
    const before = readFileSync(storePath());

    const caught = await addTrustEntry(workdir, "cli").then(
      () => null,
      (err: unknown) => err,
    );

    expect(caught).toBeInstanceOf(NaxError);
    assertNaxError(caught, "addTrustEntry rejection");
    expect(caught.code).toBe("TRUST_STORE_UNREADABLE");
    expect(readFileSync(storePath()).equals(before)).toBe(true);
  });

  test("AC18: two concurrent adds both succeed and the store lists both paths", async () => {
    const addTrustEntry = trustFn(trust, "addTrustEntry");
    const dirA = join(workdir, "a");
    const dirB = join(workdir, "b");

    const [resultA, resultB] = await Promise.all([addTrustEntry(dirA, "cli"), addTrustEntry(dirB, "cli")]);

    expect(resultA.outcome).toBe("added");
    expect(resultB.outcome).toBe("added");
    expect(
      readStore()
        .folders.map((folder: TrustEntry) => folder.path)
        .sort(byCodePoint),
    ).toEqual([dirA, dirB].sort(byCodePoint));
  });
});

describe("removeTrustEntry", () => {
  test("AC19: removes an exact entry and reports 'removed'", async () => {
    const removeTrustEntry = trustFn(trust, "removeTrustEntry");
    writeStore([{ path: workdir, addedAt: ADDED_AT, via: "cli" }]);

    const result = await removeTrustEntry(workdir);

    expect(result.outcome).toBe("removed");
    expect(readStore().folders.some((folder: TrustEntry) => folder.path === workdir)).toBe(false);
  });

  test("AC20: reports 'not-found' with the covering entry and no write for a descendant path", async () => {
    const removeTrustEntry = trustFn(trust, "removeTrustEntry");
    writeStore([{ path: workdir, addedAt: ADDED_AT, via: "cli" }]);
    const before = readFileSync(storePath());

    const result = await removeTrustEntry(join(workdir, "child"));

    expect(result.outcome).toBe("not-found");
    expect(result.outcome === "not-found" ? result.coveredBy?.path : null).toBe(workdir);
    expect(readFileSync(storePath()).equals(before)).toBe(true);
  });

  test("AC21: rejects with TRUST_STORE_UNREADABLE for an unparseable store", async () => {
    const removeTrustEntry = trustFn(trust, "removeTrustEntry");
    mkdirSync(globalDir, { recursive: true });
    writeFileSync(storePath(), "{not json");

    const caught = await removeTrustEntry(workdir).then(
      () => null,
      (err: unknown) => err,
    );

    expect(caught).toBeInstanceOf(NaxError);
    assertNaxError(caught, "removeTrustEntry rejection");
    expect(caught.code).toBe("TRUST_STORE_UNREADABLE");
  });

  test("AC22: reports 'not-found' with no covering entry and creates nothing when the global dir is missing", async () => {
    const removeTrustEntry = trustFn(trust, "removeTrustEntry");
    const missingGlobal = join(globalDir, "missing", "nested");
    process.env.NAX_GLOBAL_CONFIG_DIR = missingGlobal;

    const result = await removeTrustEntry(workdir);

    expect(result).toEqual({ outcome: "not-found", coveredBy: null });
    expect(existsSync(missingGlobal)).toBe(false);
  });
});
