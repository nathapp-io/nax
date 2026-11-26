/**
 * mirror-origin.test.ts — the mirror's record of the repository it belongs to.
 *
 * Covers US-020 AC-1..AC-3: the write when the file is absent (the realpath of the
 * repository root plus the project key), an origin the mirror already holds left exactly as
 * it is, and a write that fails costing one warn and no rejection — a host must open even
 * when the mirror's disk will not take the inventory aid.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { cleanupTempDir, type MockLogger, makeLogger, makeTempDir } from "@test/helpers";
import { _mirrorOriginDeps, ensureMirrorOrigin, ORIGIN_FILE } from "@/memory";

/** The configured project key the write cases use; it must differ from the repo basename. */
const CONFIGURED_NAME = "billing";

describe("ensureMirrorOrigin", () => {
  let parent: string;
  let projectDir: string;
  let repoRoot: string;
  let logger: MockLogger;
  let originalDeps: typeof _mirrorOriginDeps;

  /** The origin file's text, as the JSON it holds. */
  function originJson(): unknown {
    return JSON.parse(readFileSync(join(projectDir, ORIGIN_FILE), "utf8"));
  }

  /** Every warn the caller's logger has been given. */
  function warns(): readonly { readonly message: string }[] {
    return logger.calls.filter((call) => call.level === "warn");
  }

  beforeEach(() => {
    parent = makeTempDir("nax-mirror-origin-");
    projectDir = join(parent, "memory", "projects", `${CONFIGURED_NAME}-01234567`);
    repoRoot = join(parent, "api");
    mkdirSync(repoRoot, { recursive: true });
    logger = makeLogger();
    originalDeps = { ..._mirrorOriginDeps };
  });

  afterEach(() => {
    Object.assign(_mirrorOriginDeps, originalDeps);
    cleanupTempDir(parent);
  });

  test("AC-1 writes the repository root's realpath and the configured project key", async () => {
    await ensureMirrorOrigin({ projectDir, repoRoot, config: { name: CONFIGURED_NAME }, logger });

    expect(originJson()).toEqual({ root: await realpath(repoRoot), name: CONFIGURED_NAME });
  });

  test("AC-1 falls back to the repository basename when the config names no project", async () => {
    await ensureMirrorOrigin({ projectDir, repoRoot, config: {}, logger });

    expect(originJson()).toEqual({ root: await realpath(repoRoot), name: "api" });
  });

  test("AC-2 leaves an origin the mirror already holds exactly as it was", async () => {
    const existing = `${JSON.stringify({ root: "/elsewhere/checkout", name: "old-name" }, null, 2)}\n`;
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, ORIGIN_FILE), existing);

    await ensureMirrorOrigin({ projectDir, repoRoot, config: { name: CONFIGURED_NAME }, logger });

    expect({
      text: readFileSync(join(projectDir, ORIGIN_FILE), "utf8"),
      warns: warns().length,
    }).toEqual({ text: existing, warns: 0 });
  });

  test("a competing origin published after the presence check wins", async () => {
    _mirrorOriginDeps.writeFile = async (path, text) => {
      await originalDeps.writeFile(path, JSON.stringify({ name: "first", root: repoRoot }));
      await originalDeps.writeFile(path, text);
    };
    await ensureMirrorOrigin({ projectDir, repoRoot, config: { name: "second" }, logger });
    expect(originJson()).toEqual({ name: "first", root: repoRoot });
    expect(warns()).toEqual([]);
  });

  test("AC-3 resolves and warns once when writing the origin fails", async () => {
    const failure = new Error("ENOSPC: no space left on device");
    _mirrorOriginDeps.writeFile = async () => {
      throw failure;
    };

    await ensureMirrorOrigin({ projectDir, repoRoot, config: { name: CONFIGURED_NAME }, logger });

    expect(warns().map((call) => call.message)).toHaveLength(1);
  });

  test("AC-3 writes nothing and stays silent when the mirror directory cannot be created", async () => {
    _mirrorOriginDeps.mkdir = async () => {
      throw new Error("EACCES: permission denied");
    };

    await ensureMirrorOrigin({ projectDir, repoRoot, config: { name: CONFIGURED_NAME }, logger });

    expect({
      warns: warns().length,
      present: await Bun.file(join(projectDir, ORIGIN_FILE)).exists(),
    }).toEqual({ warns: 1, present: false });
  });
});
