import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { assertNaxError, cleanupTempDir, loadTrustModule, makeTempDir } from "@test/helpers";
import type { NaxError } from "@/errors";

const trust = await loadTrustModule();
const ADDED_AT = "2026-09-30T00:00:00.000Z";

let globalDir: string;
let workdir: string;
let savedGlobalEnv: string | undefined;
let savedPrompt: typeof trust._trustGateDeps.prompt | undefined;
let savedHomedir: typeof trust._trustGateDeps.homedir | undefined;

beforeEach(() => {
  globalDir = realpathSync(makeTempDir("nax-trust-gate-global-"));
  workdir = realpathSync(makeTempDir("nax-trust-gate-work-"));
  savedGlobalEnv = process.env.NAX_GLOBAL_CONFIG_DIR;
  process.env.NAX_GLOBAL_CONFIG_DIR = globalDir;
  expect(typeof trust.resetTrustRegistry).toBe("function");
  expect(typeof trust._trustGateDeps).toBe("object");
  if (typeof trust.resetTrustRegistry === "function") trust.resetTrustRegistry();
  if (trust._trustGateDeps) {
    savedPrompt = trust._trustGateDeps.prompt;
    savedHomedir = trust._trustGateDeps.homedir;
  }
});

afterEach(() => {
  if (savedPrompt && trust._trustGateDeps) trust._trustGateDeps.prompt = savedPrompt;
  if (savedHomedir && trust._trustGateDeps) trust._trustGateDeps.homedir = savedHomedir;
  if (typeof trust.resetTrustRegistry === "function") trust.resetTrustRegistry();
  cleanupTempDir(globalDir);
  cleanupTempDir(workdir);
  if (savedGlobalEnv === undefined) delete process.env.NAX_GLOBAL_CONFIG_DIR;
  else process.env.NAX_GLOBAL_CONFIG_DIR = savedGlobalEnv;
});

function storePath(): string {
  return join(globalDir, "trust.json");
}

function writeStore(path: string): void {
  mkdirSync(globalDir, { recursive: true });
  writeFileSync(storePath(), JSON.stringify({ version: 1, folders: [{ path, addedAt: ADDED_AT, via: "cli" }] }));
}

async function expectProjectUntrusted(action: Promise<unknown>): Promise<NaxError> {
  const caught = await action.then(
    () => null,
    (err: unknown) => err,
  );
  assertNaxError(caught, "trust gate rejection");
  expect(caught.code).toBe("PROJECT_UNTRUSTED");
  return caught;
}

describe("trust registry", () => {
  test("US-002 AC1: rejects an unmarked root with the execution surface in error context", async () => {
    const error = await expectProjectUntrusted(trust.assertTrusted(workdir, "hooks"));

    expect(error.context?.surface).toBe("hooks");
  });

  test("US-002 AC2: allows a descendant of a marked root", async () => {
    trust.markTrusted(workdir);

    await expect(trust.assertTrusted(join(workdir, "sub"), "plugins")).resolves.toBeUndefined();
  });

  test("US-002 AC3: does not treat a string-prefix sibling as covered", async () => {
    trust.markTrusted("/a/foo");

    await expectProjectUntrusted(trust.assertTrusted("/a/foobar", "plugins"));
  });

  test("US-002 AC4: rejects a root after the process registry is reset", async () => {
    trust.markTrusted(workdir);
    trust.resetTrustRegistry();

    await expectProjectUntrusted(trust.assertTrusted(workdir, "plugins"));
  });
});

describe("ensureProjectTrusted", () => {
  test("US-002 AC5: accepts a root covered by the persistent store and registers it", async () => {
    writeStore(workdir);

    await trust.ensureProjectTrusted(workdir, { interactive: false });

    await expect(trust.assertTrusted(join(workdir, "x"), "mcp")).resolves.toBeUndefined();
  });

  test("US-002 AC6: rejects noninteractive access with the root and CLI hint", async () => {
    const error = await expectProjectUntrusted(trust.ensureProjectTrusted(workdir, { interactive: false }));

    expect(error.context?.root).toBe(workdir);
    expect(error.context?.hint).toBe(`run: nax trust add ${workdir}`);
  });

  test("US-002 AC7: does not prompt when the invocation is noninteractive", async () => {
    let promptCalls = 0;
    trust._trustGateDeps.prompt = async () => {
      promptCalls += 1;
      return "yes";
    };

    await expectProjectUntrusted(trust.ensureProjectTrusted(workdir, { interactive: false }));

    expect(promptCalls).toBe(0);
  });

  test("US-002 AC8: prompts once with the project and its parent when interactive", async () => {
    const calls: Array<[string, string | null]> = [];
    trust._trustGateDeps.prompt = async (root, parent) => {
      calls.push([root, parent]);
      return "no";
    };

    await expectProjectUntrusted(trust.ensureProjectTrusted(workdir, { interactive: true }));

    expect(calls).toEqual([[workdir, dirname(workdir)]]);
  });

  test("US-002 AC9: persists a yes decision as a prompt trust entry", async () => {
    trust._trustGateDeps.prompt = async () => "yes";

    await trust.ensureProjectTrusted(workdir, { interactive: true });

    const saved = JSON.parse(readFileSync(storePath(), "utf8")) as { folders: Array<{ path: string; via: string }> };
    expect(saved.folders).toContainEqual(expect.objectContaining({ path: workdir, via: "prompt" }));
  });

  test("US-002 AC10: registers the root after a yes decision", async () => {
    trust._trustGateDeps.prompt = async () => "yes";

    await trust.ensureProjectTrusted(workdir, { interactive: true });

    await expect(trust.assertTrusted(workdir, "hooks")).resolves.toBeUndefined();
  });

  test("US-002 AC11: persists a parent decision for the project parent", async () => {
    trust._trustGateDeps.prompt = async () => "parent";

    await trust.ensureProjectTrusted(workdir, { interactive: true });

    const saved = JSON.parse(readFileSync(storePath(), "utf8")) as { folders: Array<{ path: string; via: string }> };
    expect(saved.folders).toContainEqual(expect.objectContaining({ path: dirname(workdir), via: "prompt" }));
  });

  test("US-002 AC12: rejects a no decision without creating a store", async () => {
    trust._trustGateDeps.prompt = async () => "no";

    await expectProjectUntrusted(trust.ensureProjectTrusted(workdir, { interactive: true }));

    expect(existsSync(storePath())).toBe(false);
  });

  test("US-002 AC13: rejects an unreadable store before prompting", async () => {
    mkdirSync(globalDir, { recursive: true });
    writeFileSync(storePath(), "{not json");
    let promptCalls = 0;
    trust._trustGateDeps.prompt = async () => {
      promptCalls += 1;
      return "yes";
    };

    const caught = await trust.ensureProjectTrusted(workdir, { interactive: true }).then(
      () => null,
      (err: unknown) => err,
    );

    assertNaxError(caught, "unreadable trust store rejection");
    expect(caught.code).toBe("TRUST_STORE_UNREADABLE");
    expect(promptCalls).toBe(0);
  });

  test("US-002 AC21: prompts a home descendant with a null parent", async () => {
    const home = realpathSync(makeTempDir("nax-trust-home-"));
    const root = join(home, "p");
    let actual: [string, string | null] | undefined;
    trust._trustGateDeps.homedir = () => home;
    trust._trustGateDeps.prompt = async (path, parent) => {
      actual = [path, parent];
      return "no";
    };

    await expectProjectUntrusted(trust.ensureProjectTrusted(root, { interactive: true }));

    expect(actual).toEqual([root, null]);
    cleanupTempDir(home);
  });

  test("US-002 AC22: refuses the home root with a force hint and no prompt", async () => {
    const home = realpathSync(makeTempDir("nax-trust-home-root-"));
    let promptCalls = 0;
    trust._trustGateDeps.homedir = () => home;
    trust._trustGateDeps.prompt = async () => {
      promptCalls += 1;
      return "yes";
    };

    const error = await expectProjectUntrusted(trust.ensureProjectTrusted(home, { interactive: true }));

    expect(error.context?.hint).toBe(`run: nax trust add ${home} --force`);
    expect(promptCalls).toBe(0);
    cleanupTempDir(home);
  });
});
