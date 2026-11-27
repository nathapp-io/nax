/** US-006 — which placeholder-shaped paths a broad `git add` must never stage. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { _placeholderDeps } from "#src/sandbox/placeholder-deps";
import type { LedgerEntry, LedgerFile } from "#src/sandbox/placeholder-ledger";
import { stagingPlaceholderPaths } from "#src/sandbox/staging-placeholders";
import { cleanupTempDir, makeTempDir, withDepsRestore } from "#test/helpers/index";

withDepsRestore(_placeholderDeps);

let base: string;
let cwd: string;
let ledgerDir: string;

/** bwrap's leaf placeholder: an empty, read-only, single-link file. */
function placeholder(target: string): void {
  writeFileSync(target, "");
  chmodSync(target, 0o444);
}

/** One ledger file in the injected ledger directory, in the shape `readLedgerFile` trusts. */
function writeLedger(pid: number, entries: readonly LedgerEntry[], mode = 0o600): void {
  const file: LedgerFile = { version: 1, pid, bootId: "boot-A", startTicks: 5, entries };
  writeFileSync(join(ledgerDir, `${pid}.json`), JSON.stringify(file), { mode });
  chmodSync(join(ledgerDir, `${pid}.json`), mode);
}

beforeEach(() => {
  base = makeTempDir("nax-staging-placeholders-");
  cwd = join(base, "repo");
  ledgerDir = join(base, "ledgers");
  mkdirSync(cwd);
  mkdirSync(ledgerDir);
  _placeholderDeps.ledgerDir = () => ledgerDir;
  // US-004: the mandatory names are a Linux source, so every case that expects
  // one pins the platform that creates it rather than inheriting the host's.
  _placeholderDeps.platform = () => "linux";
});

afterEach(() => cleanupTempDir(base));

describe("stagingPlaceholderPaths", () => {
  test("AC-8: returns the one mandatory placeholder of a directory that holds only it", () => {
    placeholder(join(cwd, ".mcp.json"));

    expect(stagingPlaceholderPaths(cwd, [])).toEqual([".mcp.json"]);
  });

  test("AC-8: returns nothing for an empty directory", () => {
    expect(stagingPlaceholderPaths(cwd, [])).toEqual([]);
  });

  test("does not return a mandatory name that is not placeholder-shaped", () => {
    writeFileSync(join(cwd, ".mcp.json"), "{}\n");

    expect(stagingPlaceholderPaths(cwd, [])).toEqual([]);
  });

  test("does not return a placeholder-shaped mandatory name that git already tracks", () => {
    placeholder(join(cwd, ".mcp.json"));

    expect(stagingPlaceholderPaths(cwd, [".mcp.json"])).toEqual([]);
  });

  test("returns a trusted ledger's entry, whatever the owner's state, relative to cwd", () => {
    mkdirSync(join(cwd, ".claude"));
    const target = join(cwd, ".claude", "settings.json");
    placeholder(target);
    // An IDENTIFIED entry of a process that is long gone: the sweep's owner check
    // is not this module's business.
    const { dev, ino } = lstatSync(target);
    writeLedger(424242, [{ path: target, kind: "file", dev, ino }]);

    expect(stagingPlaceholderPaths(cwd, [])).toEqual([".claude/settings.json"]);
  });

  test("returns a pending ledger entry whose path is now a placeholder", () => {
    mkdirSync(join(cwd, "docs"));
    placeholder(join(cwd, "docs", "x"));
    writeLedger(424242, [{ path: join(cwd, "docs", "x") }]);

    expect(stagingPlaceholderPaths(cwd, [])).toEqual(["docs/x"]);
  });

  test("ignores every entry of a ledger that fails the trust check", () => {
    mkdirSync(join(cwd, "docs"));
    placeholder(join(cwd, "docs", "x"));
    writeLedger(424242, [{ path: join(cwd, "docs", "x") }], 0o644);

    expect(stagingPlaceholderPaths(cwd, [])).toEqual([]);
  });

  test("ignores a ledger entry that lies outside cwd", () => {
    const outside = join(base, "outside");
    mkdirSync(outside);
    placeholder(join(outside, ".bashrc"));
    writeLedger(424242, [{ path: join(outside, ".bashrc") }]);

    expect(stagingPlaceholderPaths(cwd, [])).toEqual([]);
  });

  test("ignores a placeholder-shaped directory at a ledger entry, because git stages no directory", () => {
    const dir = join(cwd, "docs", "x");
    mkdirSync(dir, { recursive: true });
    writeLedger(424242, [{ path: dir }]);

    expect(stagingPlaceholderPaths(cwd, [])).toEqual([]);
  });

  test("ignores a ledger entry git already tracks", () => {
    mkdirSync(join(cwd, "docs"));
    placeholder(join(cwd, "docs", "x"));
    writeLedger(424242, [{ path: join(cwd, "docs", "x") }]);

    expect(stagingPlaceholderPaths(cwd, ["docs/x"])).toEqual([]);
  });

  test.each([".idea", ".vscode", ".claude/commands", ".claude/agents"])(
    "returns an empty 0444 FILE at the dangerous-directory name %s (#2986)",
    (name) => {
      mkdirSync(join(cwd, ".claude"), { recursive: true });
      placeholder(join(cwd, name));

      expect(stagingPlaceholderPaths(cwd, [])).toEqual([name]);
    },
  );

  test("does not return a dangerous-directory name that is a directory", () => {
    mkdirSync(join(cwd, ".idea"));
    mkdirSync(join(cwd, ".vscode"));

    expect(stagingPlaceholderPaths(cwd, [])).toEqual([]);
  });

  test("does not return a dangerous-directory name that is a real, non-empty file", () => {
    writeFileSync(join(cwd, ".idea"), "x\n");

    expect(stagingPlaceholderPaths(cwd, [])).toEqual([]);
  });

  test("does not return a placeholder-shaped dangerous-directory name that git tracks", () => {
    placeholder(join(cwd, ".idea"));

    expect(stagingPlaceholderPaths(cwd, [".idea"])).toEqual([]);
  });

  test("lists a path once when a mandatory name is also a ledger entry", () => {
    placeholder(join(cwd, ".mcp.json"));
    writeLedger(424242, [{ path: join(cwd, ".mcp.json") }]);

    expect(stagingPlaceholderPaths(cwd, [])).toEqual([".mcp.json"]);
  });

  test("falls back to the mandatory names when ledgerDir throws", () => {
    placeholder(join(cwd, ".mcp.json"));
    _placeholderDeps.ledgerDir = () => {
      throw new Error("CREDENTIALS_NOT_CONFIGURED");
    };

    expect(stagingPlaceholderPaths(cwd, [])).toEqual([".mcp.json"]);
  });

  test("falls back to the mandatory names when the ledger directory cannot be read", () => {
    placeholder(join(cwd, ".mcp.json"));
    mkdirSync(join(cwd, "docs"));
    placeholder(join(cwd, "docs", "x"));
    _placeholderDeps.ledgerDir = () => join(base, "no-such-ledger-dir");

    expect(stagingPlaceholderPaths(cwd, [])).toEqual([".mcp.json"]);
  });

  test("skips files in the ledger directory that are not ledgers, without throwing", () => {
    placeholder(join(cwd, ".mcp.json"));
    writeFileSync(join(ledgerDir, "ignore.tmp"), "not a ledger");

    expect(stagingPlaceholderPaths(cwd, [])).toEqual([".mcp.json"]);
  });

  // US-004 (#3059): only bwrap creates a placeholder at a mandatory deny name, so
  // only Linux has a reason to exclude one. Elsewhere an empty 0444 `.mcp.json` is
  // an ordinary file the user made, and a staging pass must commit it.
  test("US-004 AC-1: on darwin an empty 0444 .mcp.json is not a staging placeholder", () => {
    placeholder(join(cwd, ".mcp.json"));
    _placeholderDeps.platform = () => "darwin";

    expect(stagingPlaceholderPaths(cwd, [])).toEqual([]);
  });

  test("US-004 AC-2: on linux the same empty 0444 .mcp.json is one", () => {
    placeholder(join(cwd, ".mcp.json"));
    _placeholderDeps.platform = () => "linux";

    expect(stagingPlaceholderPaths(cwd, [])).toEqual([".mcp.json"]);
  });

  test("US-004: a ledger entry still counts on darwin, because a ledger exists only on Linux", () => {
    mkdirSync(join(cwd, "docs"));
    placeholder(join(cwd, "docs", "x"));
    writeLedger(424242, [{ path: join(cwd, "docs", "x") }]);
    _placeholderDeps.platform = () => "darwin";

    expect(stagingPlaceholderPaths(cwd, [])).toEqual(["docs/x"]);
  });
});
