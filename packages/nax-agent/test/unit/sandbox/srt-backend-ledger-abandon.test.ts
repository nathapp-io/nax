/**
 * US-004 (#3055) — the points at which the srt backend abandons pending
 * placeholder candidates.
 *
 * A pending ledger entry names a path a wrap MAY have created a bwrap placeholder
 * at, with no identity yet. Once no wrap is in flight nothing will ever identify
 * it, and a user file created later at that path — empty and 0444, the very shape
 * of a placeholder — would be adopted by the next `observe`, which is how a user's
 * own `.mcp.json` could end up treated as bwrap's. So the backend counts the wraps
 * it recorded candidates for and abandons the pending entries when the last one
 * finishes, when one throws (a failed wrap is never followed by a
 * `commandFinished`), and on `reset()`.
 *
 * Real ledger files in a real temp directory: the whole point is what the file on
 * disk holds, so a stubbed fs would prove nothing. Only the host facts and srt
 * itself are injected, as the spec's fixture conventions prescribe.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getSafeLogger, setAgentLogger } from "#src/infra/index";
import { _placeholderDeps } from "#src/sandbox/placeholder-deps";
import {
  _resetPlaceholderLedgerForTests,
  type LedgerEntry,
  placeholderLedger,
  readLedgerFile,
} from "#src/sandbox/placeholder-ledger";
import { _srtBackendDeps, createSrtBackend } from "#src/sandbox/srt-backend";
import type { SandboxWrapRequest } from "#src/sandbox/types";
import { cleanupTempDir, makeLogger, makeTempDir, withDepsRestore } from "#test/helpers/index";

withDepsRestore(_srtBackendDeps);
withDepsRestore(_placeholderDeps);

const log = makeLogger();
const realLogger = getSafeLogger();

let base: string;
let cwd: string;
let ledgerDir: string;

beforeEach(() => {
  setAgentLogger(log);
  log.reset();
  base = makeTempDir("nax-srt-ledger-abandon-");
  cwd = join(base, "repo");
  ledgerDir = join(base, "ledgers");
  mkdirSync(cwd, { recursive: true });
  _resetPlaceholderLedgerForTests();
  _placeholderDeps.platform = () => "linux";
  _placeholderDeps.ledgerDir = () => ledgerDir;
  _placeholderDeps.bootId = () => "boot-A";
  _placeholderDeps.startTicks = () => 100;
  _placeholderDeps.uid = () => process.getuid?.() ?? 0;
  _placeholderDeps.onExit = () => {};
  _srtBackendDeps.platform = () => "linux";
  _srtBackendDeps.cwd = () => cwd;
});

afterEach(() => {
  setAgentLogger(realLogger);
  _resetPlaceholderLedgerForTests();
  cleanupTempDir(base);
});

/**
 * An srt double: `wrapWithSandboxArgv` answers an argv, except for the 1-based
 * wrap `throwOnWrap` names — a wrap that fails after its candidates were
 * recorded, which is the case a `commandFinished` never follows.
 */
function stubSrt(opts: { readonly throwOnWrap?: number } = {}): void {
  let wraps = 0;
  _srtBackendDeps.load = async () => ({
    SandboxManager: {
      initialize: async () => {},
      updateConfig: () => {},
      isSupportedPlatform: () => true,
      wrapWithSandboxArgv: async () => {
        wraps += 1;
        if (opts.throwOnWrap === wraps) throw new Error("bwrap profile too long");
        return { argv: ["true"], env: {} };
      },
      annotateStderrWithSandboxFailures: (_commandId, stderr) => stderr,
      cleanupAfterCommand: () => {},
      reset: async () => {},
    },
  });
  _srtBackendDeps.mkdir = async () => undefined;
  // The sweep (US-004) and the excludes (US-007) are other steps: neither may
  // write anything these cases read.
  _srtBackendDeps.sweep = async () => undefined;
  _srtBackendDeps.ensureExcludes = async () => {};
}

/** A wrap whose only write root is the temp cwd, where srt's candidate denies live. */
function ledgerRequest(commandId: string): SandboxWrapRequest {
  return {
    command: "true",
    shell: "/bin/sh",
    policy: { writeRoots: [cwd], denyWrite: [], denyRead: [], network: {} },
    cwd,
    commandId,
  };
}

/** The ledger file this process writes. */
function processLedgerPath(): string {
  return join(ledgerDir, `${process.pid}.json`);
}

/** This process's ledger entries, or none when it holds no file. */
function ledgerEntries(): LedgerEntry[] {
  const parsed = readLedgerFile(processLedgerPath());
  return parsed === undefined ? [] : [...parsed.entries];
}

/** The paths this process's ledger records. */
function ledgerPaths(): string[] {
  return ledgerEntries().map((entry) => entry.path);
}

/** Every path any trusted ledger file in the directory records — the sweep's own view. */
function ledgerDirPaths(): string[] {
  if (!existsSync(ledgerDir)) return [];
  return readdirSync(ledgerDir)
    .filter((name) => name.endsWith(".json"))
    .flatMap((name) => (readLedgerFile(join(ledgerDir, name))?.entries ?? []).map((entry) => entry.path));
}

/** bwrap's leaf placeholder: an empty regular file, mode 0444, one link. */
function makePlaceholderFile(path: string): void {
  writeFileSync(path, "");
  chmodSync(path, 0o444);
}

describe("srt backend: abandoning pending placeholder candidates (US-004)", () => {
  test("US-004 AC-9: with two wraps in flight, the first commandFinished keeps the pending entry", async () => {
    stubSrt();
    const backend = createSrtBackend({});
    const target = join(cwd, ".zprofile");
    await backend.wrap(ledgerRequest("a"));
    await backend.wrap(ledgerRequest("b"));

    backend.commandFinished("a");

    expect(ledgerEntries()).toContainEqual({ path: target });
  });

  test("US-004 AC-10: in that case the second commandFinished removes it", async () => {
    stubSrt();
    const backend = createSrtBackend({});
    const target = join(cwd, ".zprofile");
    await backend.wrap(ledgerRequest("a"));
    await backend.wrap(ledgerRequest("b"));
    backend.commandFinished("a");

    backend.commandFinished("b");

    expect(ledgerPaths()).not.toContain(target);
    expect(existsSync(processLedgerPath())).toBe(false);
  });

  test("US-004 AC-11: a user's empty 0444 file created afterwards is never adopted", async () => {
    stubSrt();
    const backend = createSrtBackend({});
    const target = join(cwd, ".zprofile");
    await backend.wrap(ledgerRequest("a"));
    backend.commandFinished("a");
    expect(ledgerPaths()).not.toContain(target);

    // The user's own file lands at the path the abandoned candidate named...
    makePlaceholderFile(target);
    // ...and a later observe, with no wrap in flight, has nothing left to identify.
    placeholderLedger()?.observe();

    expect(ledgerDirPaths()).not.toContain(target);
  });

  test("US-004 AC-12: reset() abandons the pending entries of a wrap that never finishes", async () => {
    stubSrt();
    const backend = createSrtBackend({});
    const target = join(cwd, ".zprofile");
    await backend.wrap(ledgerRequest("a"));
    // Recorded, and no `commandFinished` will ever follow this wrap.
    expect(ledgerPaths()).toContain(target);

    await backend.reset();

    expect(ledgerDirPaths()).not.toContain(target);
  });

  test("US-004 AC-13: a wrap that throws is abandoned by the next wrap's commandFinished", async () => {
    stubSrt({ throwOnWrap: 1 });
    const backend = createSrtBackend({});
    const target = join(cwd, ".zprofile");
    // The first wrap records its candidates and then fails: no commandFinished follows.
    await expect(backend.wrap(ledgerRequest("a"))).rejects.toThrow("bwrap profile too long");
    await backend.wrap(ledgerRequest("b"));

    backend.commandFinished("b");

    expect(ledgerDirPaths()).not.toContain(target);
  });

  test("US-004: an identified placeholder that still matches its inode survives the abandon", async () => {
    stubSrt();
    const backend = createSrtBackend({});
    const target = join(cwd, ".zprofile");
    await backend.wrap(ledgerRequest("a"));
    makePlaceholderFile(target);

    backend.commandFinished("a");

    // The abandon drops PENDING entries only: a live placeholder is still the
    // inode this process recorded, and the sweep needs that identity to remove it.
    const stats = lstatSync(target);
    expect(ledgerEntries()).toContainEqual({ path: target, kind: "file", dev: stats.dev, ino: stats.ino });
  });
});
