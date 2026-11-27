/**
 * US-002 — the process-wide ledger of Linux placeholder paths
 * (src/sandbox/placeholder-ledger.ts).
 *
 * Every case runs against real files in a real temp directory: the ledger is a
 * private file whose whole job is to be trusted (or refused) from its shape on
 * disk, so a stubbed fs would prove nothing. Only the host facts are injected —
 * platform, ledger directory, boot id, start ticks, uid and the exit hook — as
 * the spec's fixture conventions prescribe, and the ledger singleton is reset
 * before each case.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmdirSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { getSafeLogger, NaxError, setAgentLogger } from "#src/infra/index";
import { realOrRaw } from "#src/internal/realpath";
import { _placeholderDeps } from "#src/sandbox/placeholder-deps";
import {
  _resetPlaceholderLedgerForTests,
  type LedgerFile,
  type PlaceholderLedger,
  placeholderLedger,
  readLedgerFile,
} from "#src/sandbox/placeholder-ledger";
import {
  assertDefined,
  cleanupTempDir,
  type LogCall,
  makeLogger,
  makeTempDir,
  withDepsRestore,
} from "#test/helpers/index";

const log = makeLogger();
const realLogger = getSafeLogger();

let base: string;
let cwd: string;
let ledgerDir: string;
let exitListeners: Array<() => void>;

withDepsRestore(_placeholderDeps);

/** The spec's fixture host facts: Linux, a temp ledger directory, fixed boot facts, a recording exit hook. */
function stubHost(): void {
  _placeholderDeps.platform = () => "linux";
  _placeholderDeps.ledgerDir = () => ledgerDir;
  _placeholderDeps.bootId = () => "boot-A";
  _placeholderDeps.startTicks = () => 100;
  _placeholderDeps.uid = () => process.getuid?.() ?? 0;
  _placeholderDeps.onExit = (listener: () => void) => {
    exitListeners.push(listener);
  };
}

beforeEach(() => {
  setAgentLogger(log);
  log.reset();
  base = realOrRaw(makeTempDir("nax-placeholder-ledger-"));
  cwd = join(base, "repo");
  ledgerDir = join(base, "ledgers");
  mkdirSync(cwd, { recursive: true });
  exitListeners = [];
  _resetPlaceholderLedgerForTests();
  stubHost();
});

afterEach(() => {
  setAgentLogger(realLogger);
  _resetPlaceholderLedgerForTests();
  cleanupTempDir(base);
});

/** The ledger file this process writes. */
function processLedgerPath(): string {
  return join(ledgerDir, `${process.pid}.json`);
}

/** A ledger file for another process, so a case can pick its own name, pid and facts. */
function ledgerContent(over: Partial<LedgerFile> = {}): LedgerFile {
  return {
    version: 1,
    pid: 999,
    bootId: "boot-A",
    startTicks: 5,
    entries: [{ path: join(cwd, ".zprofile") }],
    ...over,
  };
}

/** Write a ledger file by hand with an exact mode — the shape the trust check judges. */
function writeLedgerFile(name: string, content: unknown, mode = 0o600): string {
  mkdirSync(ledgerDir, { recursive: true });
  const path = join(ledgerDir, name);
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content), { mode });
  chmodSync(path, mode);
  return path;
}

/** The process ledger, failing the test when the fixture's host facts do not produce one. */
function currentLedger(): PlaceholderLedger {
  const ledger = placeholderLedger();
  assertDefined(ledger, "the process ledger");
  return ledger;
}

/** The process ledger's file, through the trusted reader. */
function readProcessLedger(): LedgerFile {
  const parsed = readLedgerFile(processLedgerPath());
  assertDefined(parsed, "the process ledger file");
  return parsed;
}

/** bwrap's leaf placeholder: an empty regular file, mode 0444, one link. */
function placeholderFile(path: string): void {
  writeFileSync(path, "");
  chmodSync(path, 0o444);
}

/** The line a log call renders as: `stage: message`, the spec's own spelling. */
function rendered(call: LogCall): string {
  return `${call.stage}: ${call.message}`;
}

/** Every call at `level` whose rendered line is `line`. */
function callsAt(level: LogCall["level"], line: string): LogCall[] {
  return log.calls.filter((call) => call.level === level && rendered(call) === line);
}

describe("readLedgerFile — the trust check", () => {
  test("US-002 AC1: returns the parsed ledger for a trusted 0600 file named after its pid", () => {
    const path = writeLedgerFile("999.json", ledgerContent());

    expect(readLedgerFile(path)).toEqual(ledgerContent());
  });

  test("US-002 AC2: returns undefined when the file is accessible by group or other", () => {
    expect(readLedgerFile(writeLedgerFile("999.json", ledgerContent(), 0o644))).toBeUndefined();
  });

  test("US-002 AC3: returns undefined when the file belongs to another uid", () => {
    _placeholderDeps.uid = () => (process.getuid?.() ?? 0) + 1;

    expect(readLedgerFile(writeLedgerFile("999.json", ledgerContent()))).toBeUndefined();
  });

  test("US-002 AC4: returns undefined for a file holding invalid JSON", () => {
    expect(readLedgerFile(writeLedgerFile("999.json", '{"version": 1, "entries": ['))).toBeUndefined();
  });

  test("US-002 AC5: returns undefined for a file holding version 2", () => {
    expect(readLedgerFile(writeLedgerFile("999.json", ledgerContent({ version: 2 })))).toBeUndefined();
  });

  test("US-002 AC6: returns undefined when the file's name does not match its pid", () => {
    expect(readLedgerFile(writeLedgerFile("123.json", ledgerContent()))).toBeUndefined();
  });

  test("US-002 AC7: returns undefined for an entry path that is relative or not normalised", () => {
    expect(
      readLedgerFile(writeLedgerFile("999.json", ledgerContent({ entries: [{ path: "rel/.zprofile" }] }))),
    ).toBeUndefined();
    expect(
      readLedgerFile(writeLedgerFile("999.json", ledgerContent({ entries: [{ path: "/a/../b" }] }))),
    ).toBeUndefined();
  });

  test("US-002 AC22: a refused ledger names the file it rejected in one warn", () => {
    const path = writeLedgerFile("999.json", ledgerContent(), 0o644);

    expect(readLedgerFile(path)).toBeUndefined();

    const warns = callsAt("warn", "sandbox: placeholder ledger failed the trust check");
    expect(warns.length).toBe(1);
    expect(warns[0]?.data?.file).toBe(path);
  });

  test("US-002: refuses a file whose fields are not a version 1 ledger", () => {
    const cases: unknown[] = [
      "[]",
      "null",
      { ...ledgerContent(), pid: "999" },
      { ...ledgerContent(), bootId: "" },
      { ...ledgerContent(), startTicks: 1.5 },
      { ...ledgerContent(), entries: {} },
      { ...ledgerContent(), entries: [{}] },
      { ...ledgerContent(), entries: ["the user's own"] },
    ];

    for (const content of cases) {
      expect(readLedgerFile(writeLedgerFile("999.json", content))).toBeUndefined();
    }
  });

  test("US-002: a partial identity reads back as a pending entry rather than as an identity", () => {
    const path = writeLedgerFile(
      "999.json",
      ledgerContent({ entries: [{ path: join(cwd, ".zprofile"), kind: "file" }] }),
    );

    expect(readLedgerFile(path)?.entries).toEqual([{ path: join(cwd, ".zprofile") }]);
  });

  test("US-002: an absent ledger file is skipped without a warn", () => {
    expect(readLedgerFile(join(ledgerDir, "999.json"))).toBeUndefined();
    expect(log.calls.filter((call) => call.level === "warn")).toEqual([]);
  });

  test("US-002: a directory at the ledger path is refused", () => {
    mkdirSync(join(ledgerDir, "999.json"), { recursive: true });

    expect(readLedgerFile(join(ledgerDir, "999.json"))).toBeUndefined();
    expect(callsAt("warn", "sandbox: placeholder ledger failed the trust check").length).toBe(1);
  });

  test("US-002: a symlink to a trusted ledger is refused, because lstat sees a link", () => {
    const path = writeLedgerFile("999.json", ledgerContent());
    const link = join(ledgerDir, "998.json");
    symlinkSync(path, link);

    expect(readLedgerFile(link)).toBeUndefined();
  });

  // M1: only ENOENT means "no ledger here"; any other lookup failure is a refusal.
  test.skipIf(process.getuid?.() === 0)("M1: an uninspectable ledger is refused with one warn naming it", () => {
    const locked = join(ledgerDir, "locked");
    mkdirSync(locked, { recursive: true });
    const path = join(locked, "999.json");
    writeFileSync(path, JSON.stringify(ledgerContent()), { mode: 0o600 });
    chmodSync(path, 0o600);
    chmodSync(locked, 0o000);
    try {
      expect(readLedgerFile(path)).toBeUndefined();
    } finally {
      chmodSync(locked, 0o700);
    }

    // The file could not be inspected, so nothing about it was checked: that is a
    // failed trust check, reported by name rather than swallowed as "absent" (M1).
    const warns = callsAt("warn", "sandbox: placeholder ledger failed the trust check");
    expect(warns.length).toBe(1);
    expect(warns[0]?.data?.file).toBe(path);
  });
});

describe("the process ledger", () => {
  test("US-002 AC8: recordAbsent writes a 0600 file with the process facts and a pending entry", () => {
    currentLedger().recordAbsent([join(cwd, ".zprofile")]);
    const path = processLedgerPath();

    expect(lstatSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      version: 1,
      pid: process.pid,
      bootId: "boot-A",
      startTicks: 100,
      entries: [{ path: join(cwd, ".zprofile") }],
    });
  });

  test("US-002: the ledger directory is created 0700 when the ledger is created", () => {
    currentLedger();

    expect(lstatSync(ledgerDir).isDirectory()).toBe(true);
    expect(lstatSync(ledgerDir).mode & 0o777).toBe(0o700);
  });

  test("US-002 AC9: observe records a pending path's placeholder kind, dev and ino", () => {
    const target = join(cwd, ".zprofile");
    const ledger = currentLedger();
    ledger.recordAbsent([target]);
    placeholderFile(target);

    ledger.observe();

    const stats = lstatSync(target);
    expect(readProcessLedger().entries).toEqual([{ path: target, kind: "file", dev: stats.dev, ino: stats.ino }]);
  });

  test("US-002 AC10: a path the user creates as a 0644 file with content stays pending", () => {
    const target = join(cwd, ".zprofile");
    const ledger = currentLedger();
    ledger.recordAbsent([target]);
    writeFileSync(target, "# the user's own\n");
    chmodSync(target, 0o644);

    ledger.observe();

    expect(readProcessLedger().entries).toEqual([{ path: target }]);
  });

  test("US-002 AC11: prune drops an identified entry whose file went and deletes the emptied ledger", () => {
    const target = join(cwd, ".zprofile");
    const ledger = currentLedger();
    ledger.recordAbsent([target]);
    placeholderFile(target);
    ledger.observe();
    unlinkSync(target);

    ledger.prune();

    expect(existsSync(processLedgerPath())).toBe(false);
  });

  test("US-002 AC12: prune keeps a pending entry whose path does not exist", () => {
    const target = join(cwd, ".zprofile");
    const ledger = currentLedger();
    ledger.recordAbsent([target]);

    ledger.prune();

    expect(readProcessLedger().entries).toEqual([{ path: target }]);
  });

  // US-004 (#3055): a pending entry that no wrap is left to identify is a path a
  // user file created later at would be adopted through, so the backend abandons
  // it once its last wrap is done.
  test("US-004 AC-7: prune({ abandonPending: true }) abandons a pending entry and deletes the ledger", () => {
    const ledger = currentLedger();
    ledger.recordAbsent([join(cwd, ".zprofile")]);
    expect(existsSync(processLedgerPath())).toBe(true);

    ledger.prune({ abandonPending: true });

    expect(existsSync(processLedgerPath())).toBe(false);
  });

  test("US-002: prune drops only the entries that no longer match, and rewrites the rest", () => {
    const gone = join(cwd, ".zprofile");
    const alive = join(cwd, ".zshrc");
    const pending = join(cwd, ".claude");
    const ledger = currentLedger();
    ledger.recordAbsent([gone, alive, pending]);
    placeholderFile(gone);
    placeholderFile(alive);
    ledger.observe();
    unlinkSync(gone);

    ledger.prune();

    expect(readProcessLedger().entries.map((entry) => entry.path)).toEqual([alive, pending]);
  });

  test("US-002 AC13: placeholderLedger is one instance per process, with one exit listener", () => {
    const first = placeholderLedger();
    const second = placeholderLedger();

    expect(first).toBeDefined();
    expect(second).toBe(first);
    expect(exitListeners.length).toBe(1);
  });

  test("US-002 AC14: the exit listener deletes the ledger file while its entries still match the disk", () => {
    const target = join(cwd, ".zprofile");
    const ledger = currentLedger();
    ledger.recordAbsent([target]);
    placeholderFile(target);
    ledger.observe();
    const listener = exitListeners[0];
    assertDefined(listener, "the recorded exit listener");

    listener();

    expect(existsSync(processLedgerPath())).toBe(false);
    expect(existsSync(target)).toBe(true);
  });

  test("US-002 AC15: the exit listener tolerates a ledger file that is already gone", () => {
    currentLedger();
    const listener = exitListeners[0];
    assertDefined(listener, "the recorded exit listener");
    expect(existsSync(processLedgerPath())).toBe(false);

    expect(() => listener()).not.toThrow();
  });

  test("US-002 AC20: a ledger path occupied by a directory warns once and never throws", () => {
    mkdirSync(processLedgerPath(), { recursive: true });
    const ledger = currentLedger();

    expect(() => ledger.recordAbsent([join(cwd, ".zprofile")])).not.toThrow();
    expect(() => ledger.recordAbsent([join(cwd, ".zshrc")])).not.toThrow();

    expect(callsAt("warn", "sandbox: placeholder ledger write failed").length).toBe(1);
  });

  test("US-002 AC23: a failed write is retried once the obstruction is gone", () => {
    mkdirSync(processLedgerPath(), { recursive: true });
    const ledger = currentLedger();
    ledger.recordAbsent([join(cwd, ".zprofile")]);
    expect(callsAt("warn", "sandbox: placeholder ledger write failed").length).toBe(1);

    rmdirSync(processLedgerPath());
    ledger.recordAbsent([join(cwd, ".zshrc")]);

    expect(readProcessLedger().entries).toEqual([{ path: join(cwd, ".zprofile") }, { path: join(cwd, ".zshrc") }]);
  });

  test("US-002 AC24: the exit listener does not throw when the ledger file cannot be deleted", () => {
    mkdirSync(processLedgerPath(), { recursive: true });
    currentLedger();
    const listener = exitListeners[0];
    assertDefined(listener, "the recorded exit listener");

    expect(() => listener()).not.toThrow();
  });

  test("US-002: recordAbsent rewrites nothing when the path is already recorded", () => {
    const ledger = currentLedger();
    ledger.recordAbsent([join(cwd, ".zprofile")]);
    const written = statSync(processLedgerPath()).ino;

    ledger.recordAbsent([join(cwd, ".zprofile")]);

    expect(statSync(processLedgerPath()).ino).toBe(written);
    expect(readProcessLedger().entries).toEqual([{ path: join(cwd, ".zprofile") }]);
  });

  test("US-002: observe rewrites nothing while no pending path is placeholder-shaped", () => {
    const ledger = currentLedger();
    ledger.recordAbsent([join(cwd, ".zprofile")]);
    const written = statSync(processLedgerPath()).ino;

    ledger.observe();

    expect(statSync(processLedgerPath()).ino).toBe(written);
  });

  test("US-002: recordAbsent stores paths normalised and skips a relative one", () => {
    const ledger = currentLedger();

    ledger.recordAbsent([`${cwd}/./.zprofile`, "rel/.zprofile"]);

    expect(readProcessLedger().entries).toEqual([{ path: join(cwd, ".zprofile") }]);
  });
});

describe("a disabled ledger", () => {
  test("US-002 AC16: returns undefined on darwin and installs no exit listener", () => {
    _placeholderDeps.platform = () => "darwin";

    expect(placeholderLedger()).toBeUndefined();
    expect(exitListeners.length).toBe(0);
  });

  test("US-002 AC17: returns undefined when the config dir is unconfigured", () => {
    _placeholderDeps.ledgerDir = () => {
      throw new NaxError("Credentials are not configured", "CREDENTIALS_NOT_CONFIGURED", { stage: "credentials" });
    };

    expect(placeholderLedger()).toBeUndefined();
    expect(exitListeners.length).toBe(0);
  });

  test("US-002 AC18: returns undefined when bootId throws", () => {
    _placeholderDeps.bootId = () => {
      throw new Error("no boot id");
    };

    expect(placeholderLedger()).toBeUndefined();
  });

  test("US-002 AC19: returns undefined when startTicks(process.pid) throws", () => {
    const asked: number[] = [];
    _placeholderDeps.startTicks = (pid: number) => {
      asked.push(pid);
      throw new Error("no /proc stat");
    };

    expect(placeholderLedger()).toBeUndefined();
    expect(asked).toEqual([process.pid]);
  });

  test("US-002 AC21: a disabled ledger logs one debug line, however often it is asked", () => {
    const causes: Array<[string, () => void]> = [
      [
        "a non-linux platform",
        () => {
          _placeholderDeps.platform = () => "darwin";
        },
      ],
      [
        "a throwing ledgerDir",
        () => {
          _placeholderDeps.ledgerDir = () => {
            throw new Error("no config dir");
          };
        },
      ],
      [
        "a throwing bootId",
        () => {
          _placeholderDeps.bootId = () => {
            throw new Error("no boot id");
          };
        },
      ],
      [
        "a throwing startTicks",
        () => {
          _placeholderDeps.startTicks = () => {
            throw new Error("no /proc stat");
          };
        },
      ],
    ];

    for (const [label, cause] of causes) {
      stubHost();
      _resetPlaceholderLedgerForTests();
      log.reset();
      cause();

      expect([placeholderLedger(), placeholderLedger()]).toEqual([undefined, undefined]);
      expect({ cause: label, lines: callsAt("debug", "sandbox: placeholder ledger disabled").length }).toEqual({
        cause: label,
        lines: 1,
      });
    }
  });
});
