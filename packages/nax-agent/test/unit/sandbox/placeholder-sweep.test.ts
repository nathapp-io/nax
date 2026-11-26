/** Backend-driven stale sweeps: real placeholder/ledger bytes, injected host and /proc facts. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { getSafeLogger, NaxError, setAgentLogger } from "#src/infra/index";
import { withPathFileLock } from "#src/internal/path-file-lock";
import { realOrRaw } from "#src/internal/realpath";
import { _placeholderDeps } from "#src/sandbox/placeholder-deps";
import {
  _resetPlaceholderLedgerForTests,
  type LedgerEntry,
  type LedgerFile,
  readLedgerFile,
} from "#src/sandbox/placeholder-ledger";
import { _srtBackendDeps, createSrtBackend } from "#src/sandbox/srt-backend";
import type { SandboxBackend, SandboxWrapRequest } from "#src/sandbox/types";
import { assertDefined, cleanupTempDir, makeLogger, makeTempDir, withDepsRestore } from "#test/helpers/index";

const log = makeLogger();
const realLogger = getSafeLogger();
const realRemove = _placeholderDeps.remove;
let base: string;
let cwd: string;
let ledgerDir: string;
let path: string;
let ledgerPath: string;
let file: LedgerFile;
let originalBytes: Buffer<ArrayBuffer>;
let backend: SandboxBackend;
let ownerChecks: number[];
let mountReads: number[];
let events: string[];

withDepsRestore(_placeholderDeps);
withDepsRestore(_srtBackendDeps);

function placeholder(target: string): Required<LedgerEntry> {
  writeFileSync(target, "");
  chmodSync(target, 0o444);
  const { dev, ino } = lstatSync(target);
  return { path: target, kind: "file", dev, ino };
}

function writeLedger(over: Partial<LedgerFile> = {}): void {
  file = { ...file, ...over };
  writeFileSync(ledgerPath, JSON.stringify(file), { mode: 0o600 });
  originalBytes = readFileSync(ledgerPath);
}

/** Rename over an existing name, proving this is a replacement, not inode reuse. */
function replacePlaceholder(): number {
  const oldIno = lstatSync(path).ino;
  const replacement = join(cwd, "replacement");
  const entry = placeholder(replacement);
  expect(entry.ino).not.toBe(oldIno);
  renameSync(replacement, path);
  expect(lstatSync(path).ino).toBe(entry.ino);
  return lstatSync(path).ino;
}

function request(): SandboxWrapRequest {
  return {
    command: "true",
    shell: "/bin/sh",
    cwd,
    commandId: "sweep",
    policy: { writeRoots: [cwd], denyRead: [], denyWrite: [], network: {} },
  };
}

async function wrap(): Promise<void> {
  expect(await backend.wrap(request())).toEqual(["true"]);
}

function unchanged(): void {
  expect(existsSync(path)).toBe(true);
  expect(readFileSync(ledgerPath)).toEqual(originalBytes);
}

function keptEntries(): readonly LedgerEntry[] {
  const ledger = readLedgerFile(ledgerPath);
  assertDefined(ledger, "rewritten trusted ledger");
  return ledger.entries;
}

function procError(code: string): NaxError {
  return new NaxError(`injected ${code}`, code, { stage: "sandbox" });
}

beforeEach(() => {
  base = realOrRaw(makeTempDir("nax-placeholder-sweep-"));
  cwd = join(base, "repo");
  ledgerDir = join(base, "ledgers");
  mkdirSync(cwd);
  mkdirSync(ledgerDir);
  path = join(cwd, ".zprofile");
  ledgerPath = join(ledgerDir, "999999.json");
  file = { version: 1, pid: 999999, bootId: "boot-A", startTicks: 5, entries: [placeholder(path)] };
  writeLedger();
  ownerChecks = [];
  mountReads = [];
  events = [];
  log.reset();
  setAgentLogger(log);
  _resetPlaceholderLedgerForTests();
  _placeholderDeps.platform = () => "linux";
  _placeholderDeps.ledgerDir = () => ledgerDir;
  _placeholderDeps.bootId = () => "boot-A";
  _placeholderDeps.startTicks = () => 5;
  _placeholderDeps.uid = () => process.getuid?.() ?? 0;
  _placeholderDeps.onExit = () => {};
  _placeholderDeps.isProcessAlive = (pid) => {
    ownerChecks.push(pid);
    return false;
  };
  _placeholderDeps.proc = {
    listPids: () => [101],
    realUid: () => _placeholderDeps.uid(),
    mountNs: (pid) => `mnt:[${pid}]`,
    mountinfo: (pid) => {
      mountReads.push(pid);
      return "1 0 0:1 / / rw - tmpfs tmpfs rw\n";
    },
  };
  _srtBackendDeps.platform = () => "linux";
  _srtBackendDeps.cwd = () => cwd;
  _srtBackendDeps.load = async () => ({
    SandboxManager: {
      initialize: async () => {
        events.push("initialize");
      },
      updateConfig: () => {},
      isSupportedPlatform: () => true,
      wrapWithSandboxArgv: async () => ({ argv: ["true"], env: {} }),
      annotateStderrWithSandboxFailures: (_id, stderr) => stderr,
      cleanupAfterCommand: () => {},
      reset: async () => {},
    },
  });
  backend = createSrtBackend({});
});

afterEach(() => {
  setAgentLogger(realLogger);
  _resetPlaceholderLedgerForTests();
  cleanupTempDir(base);
});

describe("dead-owner placeholder sweep through first Linux wrap", () => {
  test("AC-1: removes the stale placeholder and logs its path once", async () => {
    await wrap();
    expect(existsSync(path)).toBe(false);
    const removed = log.calls.filter((call) => call.level === "info" && call.message === "removed stale placeholders");
    expect(removed).toHaveLength(1);
    expect(removed[0]?.data).toEqual({ removed: [path] });
  });

  test("AC-2: deletes the exhausted dead-owner ledger", async () => {
    await wrap();
    expect(existsSync(ledgerPath)).toBe(false);
  });

  test("AC-3: keeps a rename-over replacement with a different inode", async () => {
    const ino = replacePlaceholder();
    await wrap();
    expect(lstatSync(path).ino).toBe(ino);
    expect(existsSync(ledgerPath)).toBe(false);
  });

  test("AC-4: keeps a nonempty former placeholder with its byte", async () => {
    chmodSync(path, 0o644);
    writeFileSync(path, "x");
    chmodSync(path, 0o444);
    await wrap();
    expect(readFileSync(path, "utf8")).toBe("x");
    expect(existsSync(ledgerPath)).toBe(false);
  });

  test("AC-5: rechecks identity after mountinfo replaces the placeholder", async () => {
    let replacementIno = 0;
    _placeholderDeps.proc.mountinfo = () => {
      replacementIno = replacePlaceholder();
      return "";
    };
    await wrap();
    expect(replacementIno).not.toBe(0);
    expect(lstatSync(path).ino).toBe(replacementIno);
  });

  test("AC-6: retains a live mount and its ledger entry", async () => {
    _placeholderDeps.proc.mountinfo = (pid) => {
      mountReads.push(pid);
      return `1 0 0:1 / ${path} ro - tmpfs tmpfs ro\n`;
    };
    await wrap();
    expect(mountReads).toEqual([101]);
    expect(existsSync(path)).toBe(true);
    expect(keptEntries()).toEqual(file.entries);
  });

  test("AC-7: EACCES leaves placeholder and ledger bytes unchanged", async () => {
    _placeholderDeps.proc.mountinfo = (pid) => {
      mountReads.push(pid);
      throw procError("EACCES");
    };
    await wrap();
    expect(mountReads).toEqual([101]);
    unchanged();
  });

  /**
   * #2986 (D4): a same-uid pid whose mount namespace cannot be read (systemd --user,
   * sshd-session) is harmless to a dead owner when it STARTED BEFORE that owner:
   * a sandbox binds a placeholder only after it exists, and it exists only after
   * the owner started. Owner ticks here are 5; pid 102 is the unreadable one.
   */
  describe("an unreadable same-uid pid (#2986)", () => {
    function unreadable102(statTicks: (pid: number) => number): void {
      _placeholderDeps.proc.listPids = () => [101, 102];
      const read = _placeholderDeps.proc.mountinfo;
      _placeholderDeps.proc.mountinfo = (pid) => {
        if (pid === 102) throw procError("EACCES");
        return read(pid);
      };
      _placeholderDeps.startTicks = statTicks;
    }

    test("one that started before the owner does not block removal", async () => {
      unreadable102((pid) => (pid === 102 ? 4 : 5));
      await wrap();
      expect(existsSync(path)).toBe(false);
      expect(existsSync(ledgerPath)).toBe(false);
    });

    test("one that started after the owner leaves the placeholder and ledger untouched", async () => {
      unreadable102((pid) => (pid === 102 ? 6 : 5));
      await wrap();
      unchanged();
    });

    test("one that started at the same tick as the owner is not strictly older, so it blocks", async () => {
      unreadable102(() => 5);
      await wrap();
      unchanged();
    });

    test("one whose start ticks cannot be read blocks removal", async () => {
      unreadable102((pid) => {
        if (pid === 102) throw procError("EACCES");
        return 5;
      });
      await wrap();
      unchanged();
    });

    test("an unreadable ns/mnt of an older pid is harmless the same way", async () => {
      _placeholderDeps.proc.listPids = () => [101, 102];
      const ns = _placeholderDeps.proc.mountNs;
      _placeholderDeps.proc.mountNs = (pid) => {
        if (pid === 102) throw procError("EPERM");
        return ns(pid);
      };
      _placeholderDeps.startTicks = (pid) => (pid === 102 ? 1 : 5);
      await wrap();
      expect(existsSync(path)).toBe(false);
    });

    test("scans /proc once for several dead-owner ledgers", async () => {
      unreadable102((pid) => (pid === 102 ? 4 : 5));
      const scans: number[] = [];
      const list = _placeholderDeps.proc.listPids;
      _placeholderDeps.proc.listPids = () => {
        scans.push(1);
        return list();
      };
      writeFileSync(join(ledgerDir, "999998.json"), JSON.stringify({ ...file, pid: 999998, entries: [] }), {
        mode: 0o600,
      });
      await wrap();
      expect(scans).toHaveLength(1);
    });

    test("an older unreadable pid does not unblock a ledger from an earlier boot", async () => {
      // Start ticks from different boots are not comparable, so "older" proves nothing.
      writeLedger({ bootId: "boot-B" });
      unreadable102((pid) => (pid === 102 ? 4 : 5));
      await wrap();
      unchanged();
    });

    test("compares the unreadable pid against each dead owner separately", async () => {
      // Owner 999999 started at 5, owner 999998 at 3; the unreadable pid at 4 sits between.
      const youngerOwnerPath = join(cwd, ".zshrc");
      const youngerOwnerLedger = join(ledgerDir, "999998.json");
      const entry = placeholder(youngerOwnerPath);
      writeFileSync(youngerOwnerLedger, JSON.stringify({ ...file, pid: 999998, startTicks: 3, entries: [entry] }), {
        mode: 0o600,
      });
      unreadable102((pid) => (pid === 102 ? 4 : 5));
      await wrap();
      expect(existsSync(path)).toBe(false);
      expect(existsSync(youngerOwnerPath)).toBe(true);
      expect(existsSync(youngerOwnerLedger)).toBe(true);
    });
  });

  test("AC-8: a second pid disappearing with ENOENT does not block cleanup", async () => {
    const attempts: number[] = [];
    _placeholderDeps.proc.listPids = () => [101, 102];
    const read = _placeholderDeps.proc.mountinfo;
    _placeholderDeps.proc.mountinfo = (pid) => {
      attempts.push(pid);
      if (pid === 102) throw procError("ENOENT");
      return read(pid);
    };
    await wrap();
    expect(attempts).toEqual([101, 102]);
    expect(existsSync(path)).toBe(false);
  });

  test("AC-9: never reads another uid's mountinfo", async () => {
    const uidReads: number[] = [];
    _placeholderDeps.proc.listPids = () => [101, 102];
    _placeholderDeps.proc.realUid = (pid) => {
      uidReads.push(pid);
      return _placeholderDeps.uid() + (pid === 102 ? 1 : 0);
    };
    await wrap();
    expect(uidReads).toEqual([101, 102]);
    expect(mountReads).toEqual([101]);
    expect(existsSync(path)).toBe(false);
  });

  test("AC-10: reads a shared mount namespace once", async () => {
    const namespaceReads: number[] = [];
    _placeholderDeps.proc.listPids = () => [101, 102];
    _placeholderDeps.proc.mountNs = (pid) => {
      namespaceReads.push(pid);
      return "mnt:[shared]";
    };
    await wrap();
    expect(namespaceReads).toEqual([101, 102]);
    expect(mountReads).toEqual([101]);
    expect(existsSync(path)).toBe(false);
  });

  test("AC-11: a live owner with matching ticks is untouched", async () => {
    _placeholderDeps.isProcessAlive = (pid) => {
      ownerChecks.push(pid);
      return true;
    };
    await wrap();
    expect(ownerChecks).toEqual([999999]);
    unchanged();
    expect(mountReads).toEqual([]);
  });

  test("AC-12: pid reuse makes the recorded owner dead", async () => {
    _placeholderDeps.isProcessAlive = () => true;
    _placeholderDeps.startTicks = (pid) => (pid === 999999 ? 6 : 5);
    await wrap();
    expect(existsSync(path)).toBe(false);
  });

  test("AC-13: inaccessible start ticks conservatively mean alive", async () => {
    const tickReads: number[] = [];
    _placeholderDeps.isProcessAlive = () => true;
    _placeholderDeps.startTicks = (pid) => {
      tickReads.push(pid);
      if (pid === 999999) throw procError("EACCES");
      return 5;
    };
    await wrap();
    expect(tickReads).toContain(999999);
    unchanged();
  });

  test("AC-14: an old boot makes an apparently live owner dead", async () => {
    writeLedger({ bootId: "boot-B" });
    _placeholderDeps.isProcessAlive = () => true;
    await wrap();
    expect(existsSync(path)).toBe(false);
  });

  test("AC-15: removes an empty directory but preserves one holding a file", async () => {
    unlinkSync(path);
    mkdirSync(path);
    const { dev, ino } = lstatSync(path);
    writeLedger({ entries: [{ path, kind: "dir", dev, ino }] });
    await wrap();
    expect(existsSync(path)).toBe(false);

    mkdirSync(path);
    const identity = lstatSync(path);
    writeLedger({ entries: [{ path, kind: "dir", dev: identity.dev, ino: identity.ino }] });
    writeFileSync(join(path, "user-file"), "keep");
    backend = createSrtBackend({});
    await wrap();
    expect(readFileSync(join(path, "user-file"), "utf8")).toBe("keep");
    expect(existsSync(ledgerPath)).toBe(false);
  });

  test("AC-16: drops a pending entry without deleting its shaped path", async () => {
    writeLedger({ entries: [{ path }] });
    await wrap();
    expect(existsSync(path)).toBe(true);
    expect(existsSync(ledgerPath)).toBe(false);
    expect(mountReads).toEqual([]);
  });

  test("AC-17: refuses a 0644 ledger without changing its bytes", async () => {
    chmodSync(ledgerPath, 0o644);
    await wrap();
    unchanged();
    expect(
      log.calls.filter((call) => call.level === "warn" && call.message === "placeholder ledger failed the trust check"),
    ).toHaveLength(1);
    expect(ownerChecks).toEqual([]);
  });

  test("AC-18: keeps a failed removal but continues with the next entry", async () => {
    const bashrc = join(cwd, ".bashrc");
    writeLedger({ entries: [...file.entries, placeholder(bashrc)] });
    _placeholderDeps.remove = (target, kind) => {
      if (target === path) throw procError("EACCES");
      realRemove(target, kind);
    };
    await wrap();
    expect(existsSync(path)).toBe(true);
    expect(existsSync(bashrc)).toBe(false);
    expect(keptEntries()).toEqual([file.entries[0]]);
    expect(lstatSync(ledgerPath).mode & 0o777).toBe(0o600);
  });

  test("AC-19: skips a held ledger lock after the configured timeout", async () => {
    writeFileSync(`${ledgerPath}.lock`, `${process.pid}\n`, { flag: "wx" });
    _placeholderDeps.lockTimeoutMs = 50;
    await wrap();
    expect(ownerChecks).toEqual([999999]);
    unchanged();
    expect(mountReads).toEqual([]);
  });

  test("AC-20: silently skips a ledger deleted during the owner check", async () => {
    _placeholderDeps.isProcessAlive = (pid) => {
      ownerChecks.push(pid);
      unlinkSync(ledgerPath);
      return false;
    };
    await wrap();
    expect(ownerChecks).toEqual([999999]);
    expect(existsSync(path)).toBe(true);
    expect(existsSync(ledgerPath)).toBe(false);
    expect(log.calls.filter((call) => call.level === "error" || call.level === "warn")).toEqual([]);
  });

  test("AC-21: warns when sweep throws and still wraps true", async () => {
    _srtBackendDeps.sweep = () => {
      throw procError("EACCES");
    };
    await wrap();
    expect(
      log.calls.filter(
        (call) => call.level === "warn" && call.stage === "sandbox" && call.data?.error === "injected EACCES",
      ),
    ).toHaveLength(1);
  });

  test("AC-22: sweeps once per initialize, again after reset, before srt initialize", async () => {
    let calls = 0;
    _srtBackendDeps.sweep = async () => {
      calls += 1;
      events.push("sweep");
    };
    await wrap();
    await wrap();
    await wrap();
    expect(calls).toBe(1);
    expect(events).toEqual(["sweep", "initialize"]);
    await backend.reset();
    await wrap();
    expect(calls).toBe(2);
    expect(events).toEqual(["sweep", "initialize", "sweep", "initialize"]);
  });

  test("AC-23: emits one debug log for an unknown live mount set", async () => {
    _placeholderDeps.proc.mountinfo = () => {
      throw procError("EACCES");
    };
    await wrap();
    const calls = log.calls.filter(
      (call) => call.level === "debug" && call.message === "live placeholder mount set unknown",
    );
    expect(calls).toHaveLength(1);
    unchanged();
  });

  test("AC-24: drops the entry when the last identity check finds a new inode", async () => {
    _placeholderDeps.proc.mountinfo = () => {
      replacePlaceholder();
      return "";
    };
    await wrap();
    expect(existsSync(path)).toBe(true);
    expect(existsSync(ledgerPath)).toBe(false);
  });
});

describe("sweep safety and platform boundaries", () => {
  test("ENOENT start ticks prove a previously live owner dead", async () => {
    _placeholderDeps.isProcessAlive = () => true;
    _placeholderDeps.startTicks = (pid) => {
      if (pid === 999999) throw procError("ENOENT");
      return 5;
    };
    await wrap();
    expect(existsSync(path)).toBe(false);
  });

  for (const reader of ["realUid", "mountNs", "mountinfo"] as const) {
    for (const code of ["ENOENT", "ESRCH"]) {
      test(`${reader} ${code} skips only the departed pid`, async () => {
        _placeholderDeps.proc.listPids = () => [102, 101];
        const read = _placeholderDeps.proc[reader];
        Object.assign(_placeholderDeps.proc, {
          [reader]: (pid: number) => {
            if (pid === 102) throw procError(code);
            return read(pid);
          },
        });
        await wrap();
        expect(existsSync(path)).toBe(false);
      });
    }
    test(`${reader} EACCES makes all mounts unknown`, async () => {
      Object.assign(_placeholderDeps.proc, {
        [reader]: () => {
          throw procError("EACCES");
        },
      });
      await wrap();
      expect(log.calls.filter((call) => call.message === "live placeholder mount set unknown")).toHaveLength(1);
      unchanged();
    });
  }

  test("listPids failure makes mounts unknown", async () => {
    _placeholderDeps.proc.listPids = () => {
      throw procError("EACCES");
    };
    await wrap();
    expect(log.calls.filter((call) => call.message === "live placeholder mount set unknown")).toHaveLength(1);
    unchanged();
  });

  test("shares one mount snapshot across all dead-owner ledgers", async () => {
    const otherPath = join(cwd, ".bashrc");
    const otherFile = { ...file, pid: 999998, entries: [placeholder(otherPath)] };
    writeFileSync(join(ledgerDir, "999998.json"), JSON.stringify(otherFile), { mode: 0o600 });
    await wrap();
    expect(existsSync(path)).toBe(false);
    expect(existsSync(otherPath)).toBe(false);
    expect(mountReads).toEqual([101]);
    const infos = log.calls.filter((call) => call.message === "removed stale placeholders");
    expect(infos).toHaveLength(1);
    expect(infos[0]?.data?.removed).toEqual(expect.arrayContaining([path, otherPath]));
  });

  test("unknown snapshot leaves every ledger unchanged and logs debug once", async () => {
    const otherLedger = join(ledgerDir, "999998.json");
    const bytes = JSON.stringify({ ...file, pid: 999998 });
    writeFileSync(otherLedger, bytes, { mode: 0o600 });
    _placeholderDeps.proc.mountinfo = (pid) => {
      mountReads.push(pid);
      throw procError("EACCES");
    };
    await wrap();
    unchanged();
    expect(readFileSync(otherLedger, "utf8")).toBe(bytes);
    expect(mountReads).toEqual([101]);
    expect(log.calls.filter((call) => call.message === "live placeholder mount set unknown")).toHaveLength(1);
  });

  test("rechecks ledger trust under the lock", async () => {
    _placeholderDeps.isProcessAlive = () => {
      chmodSync(ledgerPath, 0o644);
      return false;
    };
    await wrap();
    unchanged();
    expect(lstatSync(ledgerPath).mode & 0o777).toBe(0o644);
    expect(log.calls.filter((call) => call.message === "placeholder ledger failed the trust check")).toHaveLength(1);
  });

  // B2: the owner is checked before the lock, and must be checked again after it.
  test("B2: a live ledger written while the sweep waits for the lock survives byte for byte", async () => {
    // Hold the ledger's lock, so the sweep has to wait after its owner check.
    let releaseLock: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    let lockEntered: () => void = () => {};
    const inLock = new Promise<void>((resolve) => {
      lockEntered = resolve;
    });
    const holder = withPathFileLock(ledgerPath, async () => {
      lockEntered();
      await held;
    });
    await inLock;

    // Signals that the sweep has read the dead ledger and judged its owner dead:
    // it is waiting now for the lock this case still holds.
    let ownerChecked: () => void = () => {};
    const ownerCheck = new Promise<void>((resolve) => {
      ownerChecked = resolve;
    });
    _placeholderDeps.isProcessAlive = (pid) => {
      ownerChecks.push(pid);
      ownerChecked();
      return false;
    };
    const sweep = wrap();
    await ownerCheck;

    // A live process inherits the pid and writes its OWN ledger at that path: the
    // same pid, new start ticks, and one pending entry — the provenance of the
    // placeholders it still owns and has not observed yet.
    const live = { ...file, startTicks: 6, entries: [{ path: join(cwd, ".profile") }] };
    const liveBytes = `${JSON.stringify(live)}\n`;
    writeFileSync(ledgerPath, liveBytes);
    _placeholderDeps.isProcessAlive = () => true;
    _placeholderDeps.startTicks = () => 6;

    releaseLock();
    await holder;
    await sweep;

    // The live record is not this sweep's to filter or delete: doing that lost the
    // active process's provenance (B2).
    expect(readFileSync(ledgerPath, "utf8")).toBe(liveBytes);
    expect(existsSync(path)).toBe(true);
  });

  test("malformed identity is dropped without touching its file", async () => {
    writeFileSync(ledgerPath, JSON.stringify({ ...file, entries: [{ path, kind: "file", dev: "bad", ino: 1 }] }));
    await wrap();
    expect(existsSync(path)).toBe(true);
    expect(existsSync(ledgerPath)).toBe(false);
    expect(mountReads).toEqual([]);
  });

  test("trusted rewrites never follow a predictable temp-file symlink", async () => {
    const victim = join(base, "victim");
    writeFileSync(victim, "untouched");
    symlinkSync(victim, join(ledgerDir, ".999999.tmp"));
    const bashrc = join(cwd, ".bashrc");
    writeLedger({ entries: [...file.entries, placeholder(bashrc)] });
    _placeholderDeps.remove = (target, kind) => {
      if (target === path) throw procError("EACCES");
      realRemove(target, kind);
    };
    await wrap();
    expect(existsSync(bashrc)).toBe(false);
    expect(keptEntries()).toEqual([file.entries[0]]);
    expect(readFileSync(victim, "utf8")).toBe("untouched");
  });

  test("compares mount points using the real parent", async () => {
    const alias = join(base, "alias with space");
    symlinkSync(cwd, alias);
    const aliasPath = join(alias, ".zprofile");
    writeLedger({ entries: [{ ...file.entries[0], path: aliasPath }] });
    _placeholderDeps.proc.mountinfo = (pid) => {
      mountReads.push(pid);
      return `1 0 0:1 / ${path} ro - tmpfs tmpfs ro`;
    };
    await wrap();
    expect(mountReads).toEqual([101]);
    expect(existsSync(path)).toBe(true);
    expect(keptEntries()).toEqual(file.entries);
  });

  test("skips its own ledger and non-json files", async () => {
    unlinkSync(ledgerPath);
    const ownFile = join(ledgerDir, `${process.pid}.json`);
    const bytes = JSON.stringify({ ...file, pid: process.pid });
    writeFileSync(ownFile, bytes, { mode: 0o600 });
    writeFileSync(join(ledgerDir, "ignore.tmp"), "not JSON");
    await backend.wrap({ ...request(), policy: { ...request().policy, writeRoots: [] } });
    expect(readFileSync(ownFile, "utf8")).toBe(bytes);
    expect(ownerChecks).toEqual([]);
    expect(log.calls).toEqual([]);
  });

  test("a missing ledger directory is a no-op", async () => {
    _placeholderDeps.ledgerDir = () => join(base, "missing");
    await wrap();
    expect(existsSync(path)).toBe(true);
    expect(log.calls.filter((call) => call.level === "warn")).toEqual([]);
  });

  for (const platform of ["darwin", "win32", "freebsd"] as const) {
    test(`${platform}: no sweep, proc, or ledger work`, async () => {
      _srtBackendDeps.platform = () => platform;
      _srtBackendDeps.mkdir = async () => undefined;
      let sweeps = 0;
      _srtBackendDeps.sweep = async () => {
        sweeps += 1;
      };
      _placeholderDeps.ledgerDir = () => {
        throw procError("unexpected ledger read");
      };
      await wrap();
      expect(sweeps).toBe(0);
      expect(ownerChecks).toEqual([]);
      expect(mountReads).toEqual([]);
      expect(events).toEqual(["initialize"]);
      expect(log.calls).toEqual([]);
      unchanged();
    });
  }
});
