import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getSafeLogger, NaxError, setAgentLogger } from "#src/infra/index";
import { _srtBackendDeps, createSrtBackend, probeSandbox, type SandboxWrapRequest } from "#src/sandbox/index";
import { _placeholderDeps } from "#src/sandbox/placeholder-deps";
import { _resetPlaceholderLedgerForTests, type LedgerEntry, readLedgerFile } from "#src/sandbox/placeholder-ledger";
import {
  assertDefined,
  cleanupTempDir,
  type LogCall,
  makeLogger,
  makeTempDir,
  withDepsRestore,
} from "#test/helpers/index";

const backend = createSrtBackend({});
const probe = await probeSandbox(backend);
const label = probe.available ? "available" : `SKIPPED: ${probe.reason}`;

describe(`srt backend (${label})`, () => {
  afterAll(() => backend.reset());

  test.skipIf(!probe.available)("open network: the wrapped argv sets no proxy variables", async () => {
    const argv = await backend.wrap({
      command: "true",
      shell: "/bin/sh",
      policy: { writeRoots: [process.cwd()], denyWrite: [], denyRead: [], network: {} },
      cwd: process.cwd(),
      commandId: "t1",
    });
    backend.commandFinished();
    expect(argv.join(" ")).not.toContain("HTTPS_PROXY=");
  });

  test.skipIf(!probe.available)("wrap returns argv only -- the backend's env never crosses (F6)", async () => {
    const argv = await backend.wrap({
      command: "true",
      shell: "/bin/sh",
      policy: { writeRoots: [process.cwd()], denyWrite: [], denyRead: [], network: {} },
      cwd: process.cwd(),
      commandId: "t2",
    });
    backend.commandFinished();
    expect(Array.isArray(argv)).toBe(true);
    expect(argv.every((a) => typeof a === "string")).toBe(true);
  });
});

/**
 * Linux bwrap mount-point cleanup.
 *
 * srt counts every wrapped command itself (`activeSandboxCount`, incremented per
 * `wrapWithSandboxArgv`, decremented per `cleanupAfterCommand`) and deletes the
 * placeholder files (`.bashrc`, `.profile`, `.claude/commands`, ...) only when its
 * count reaches zero. The backend must therefore call `cleanupAfterCommand` once
 * per finished command. Gating that call behind a second, nax-side counter leaks
 * srt's count after any overlap, and the placeholders then outlive every command.
 */
interface StubSrtOptions {
  readonly wrapThrows?: boolean;
  /** Runs inside `cleanupAfterCommand`, so a test can read the ledger at the moment srt would act. */
  readonly onCleanup?: () => void;
  /** The argv srt hands back for a wrapped command. */
  readonly argv?: readonly string[];
}

/** A stand-in for srt that keeps srt's own count and reports when it would delete placeholders. */
function installCountingSrt(opts: StubSrtOptions = {}): {
  readonly cleanups: () => number;
  readonly placeholdersRemoved: () => number;
  readonly wraps: () => number;
} {
  let active = 0;
  let cleanups = 0;
  let placeholdersRemoved = 0;
  let wraps = 0;
  const argv = opts.argv !== undefined ? [...opts.argv] : ["/bin/sh", "-c", "true"];
  _srtBackendDeps.load = async () => ({
    SandboxManager: {
      initialize: async () => {},
      updateConfig: () => {},
      isSupportedPlatform: () => true,
      wrapWithSandboxArgv: async () => {
        if (opts.wrapThrows === true) throw new Error("bwrap profile too long");
        wraps += 1;
        active += 1;
        return { argv, env: {} };
      },
      annotateStderrWithSandboxFailures: (_command, stderr) => stderr,
      cleanupAfterCommand: () => {
        cleanups += 1;
        opts.onCleanup?.();
        if (active > 0) active -= 1;
        if (active === 0) placeholdersRemoved += 1;
      },
      reset: async () => {},
    },
  });
  _srtBackendDeps.mkdir = async () => undefined;
  return { cleanups: () => cleanups, placeholdersRemoved: () => placeholdersRemoved, wraps: () => wraps };
}

function request(commandId: string): SandboxWrapRequest {
  return {
    command: "true",
    shell: "/bin/sh",
    policy: { writeRoots: [process.cwd()], denyWrite: [], denyRead: [], network: {} },
    cwd: process.cwd(),
    commandId,
  };
}

describe("srt backend mount-point cleanup", () => {
  const realLoad = _srtBackendDeps.load;
  const realMkdir = _srtBackendDeps.mkdir;

  afterEach(() => {
    _srtBackendDeps.load = realLoad;
    _srtBackendDeps.mkdir = realMkdir;
  });

  test("each finished command reports its cleanup to srt", async () => {
    const srt = installCountingSrt();
    const backend = createSrtBackend({});

    await backend.wrap(request("a"));
    await backend.wrap(request("b"));
    backend.commandFinished();
    backend.commandFinished();

    expect(srt.cleanups()).toBe(2);
  });

  test("placeholders are removed once overlapping commands have all finished", async () => {
    const srt = installCountingSrt();
    const backend = createSrtBackend({});

    await backend.wrap(request("a"));
    await backend.wrap(request("b"));
    backend.commandFinished();
    expect(srt.placeholdersRemoved()).toBe(0);
    backend.commandFinished();

    expect(srt.placeholdersRemoved()).toBe(1);
  });

  test("a later lone command still removes its placeholders after an earlier overlap", async () => {
    const srt = installCountingSrt();
    const backend = createSrtBackend({});

    await backend.wrap(request("a"));
    await backend.wrap(request("b"));
    backend.commandFinished();
    backend.commandFinished();
    await backend.wrap(request("c"));
    backend.commandFinished();

    expect(srt.placeholdersRemoved()).toBe(2);
  });

  test("a wrap that throws leaves srt's count alone and reaches no cleanup", async () => {
    const srt = installCountingSrt({ wrapThrows: true });
    const backend = createSrtBackend({});

    await expect(backend.wrap(request("a"))).rejects.toThrow("bwrap profile too long");

    expect(srt.cleanups()).toBe(0);
  });

  test("commandFinished before any wrap does not reach srt", () => {
    const srt = installCountingSrt();
    const backend = createSrtBackend({});

    backend.commandFinished();

    expect(srt.cleanups()).toBe(0);
  });
});

/**
 * US-003 — the Linux ledger wiring around srt's own placeholder handling.
 *
 * The real ledger runs against a real temp cwd: record → observe → prune is a
 * sequence about inodes on disk, so a stubbed fs would prove nothing. Only the
 * host facts (platform, ledger directory, boot id, start ticks, uid, the exit
 * hook) and srt itself are injected, so every case runs on every platform.
 */
describe("srt backend placeholder ledger (Linux)", () => {
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
    base = makeTempDir("nax-srt-ledger-");
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

  /** Every call at `level` whose rendered line is `` `stage: message` ``. */
  function callsAt(level: LogCall["level"], line: string): LogCall[] {
    return log.calls.filter((call) => call.level === level && `${call.stage}: ${call.message}` === line);
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

  /** bwrap's leaf placeholder: an empty regular file, mode 0444, one link. */
  function makePlaceholderFile(path: string): void {
    writeFileSync(path, "");
    chmodSync(path, 0o444);
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

  test("US-003 AC1: wrap records the cwd's placeholder candidates as pending", async () => {
    installCountingSrt();
    const backend = createSrtBackend({});

    await backend.wrap(ledgerRequest("a"));

    expect(existsSync(processLedgerPath())).toBe(true);
    expect(ledgerEntries()).toContainEqual({ path: join(cwd, ".zprofile") });
  });

  test("US-003: candidates resolve against the process cwd, not the request's cwd", async () => {
    const elsewhere = join(base, "elsewhere");
    mkdirSync(elsewhere, { recursive: true });
    installCountingSrt();
    const backend = createSrtBackend({});

    await backend.wrap({ ...ledgerRequest("a"), cwd: elsewhere });

    expect(ledgerPaths()).toContain(join(cwd, ".zprofile"));
    expect(ledgerPaths()).not.toContain(join(elsewhere, ".zprofile"));
  });

  test("US-003 AC2: commandFinished records the placeholder's dev and ino", async () => {
    installCountingSrt();
    const backend = createSrtBackend({});
    const target = join(cwd, ".zprofile");
    await backend.wrap(ledgerRequest("a"));
    makePlaceholderFile(target);

    backend.commandFinished();

    const stats = lstatSync(target);
    expect(ledgerEntries()).toContainEqual({ path: target, kind: "file", dev: stats.dev, ino: stats.ino });
  });

  test("US-003 AC3: the identity is already on disk when srt's cleanup runs", async () => {
    let atCleanup: readonly LedgerEntry[] | undefined;
    installCountingSrt({
      onCleanup: () => {
        atCleanup = ledgerEntries();
      },
    });
    const backend = createSrtBackend({});
    const target = join(cwd, ".zprofile");
    await backend.wrap(ledgerRequest("a"));
    makePlaceholderFile(target);

    backend.commandFinished();

    assertDefined(atCleanup, "the ledger content srt's cleanup read");
    const stats = lstatSync(target);
    expect(atCleanup).toContainEqual({ path: target, kind: "file", dev: stats.dev, ino: stats.ino });
  });

  test("US-003 AC4: a placeholder srt deleted is dropped by the next commandFinished", async () => {
    installCountingSrt();
    const backend = createSrtBackend({});
    const target = join(cwd, ".zprofile");
    await backend.wrap(ledgerRequest("a"));
    makePlaceholderFile(target);
    backend.commandFinished();
    expect(ledgerPaths()).toContain(target);
    unlinkSync(target);

    backend.commandFinished();

    expect(ledgerPaths()).not.toContain(target);
  });

  test("US-003 AC5: a .bashrc the user wrote before the first wrap never enters the ledger", async () => {
    installCountingSrt();
    const backend = createSrtBackend({});
    writeFileSync(join(cwd, ".bashrc"), "# the user's own\n");

    await backend.wrap(ledgerRequest("a"));
    backend.commandFinished();
    await backend.wrap(ledgerRequest("b"));

    // While this wrap is in flight the absent names are recorded as pending...
    expect(ledgerPaths()).toContain(join(cwd, ".zprofile"));
    // ...and the user's own existing file never is.
    expect(ledgerPaths()).not.toContain(join(cwd, ".bashrc"));

    backend.commandFinished();

    // US-004: the last commandFinished abandons what no wrap is left to identify,
    // and the user's file is still theirs.
    expect(ledgerPaths()).not.toContain(join(cwd, ".zprofile"));
    expect(readFileSync(join(cwd, ".bashrc"), "utf8")).toBe("# the user's own\n");
  });

  test("US-003 AC6: reset drops an identified entry whose placeholder has gone", async () => {
    installCountingSrt();
    const backend = createSrtBackend({});
    const target = join(cwd, ".zprofile");
    await backend.wrap(ledgerRequest("a"));
    makePlaceholderFile(target);
    backend.commandFinished();
    expect(ledgerPaths()).toContain(target);
    unlinkSync(target);

    await backend.reset();

    expect(ledgerPaths()).not.toContain(target);
  });

  test("US-003 AC7: on darwin srt is called once per call and no ledger is written", async () => {
    _srtBackendDeps.platform = () => "darwin";
    _placeholderDeps.platform = () => "darwin";
    // Nothing ledger-side may be consulted: resolving candidates reads this seam.
    _srtBackendDeps.cwd = () => {
      throw new Error("the placeholder ledger ran on darwin");
    };
    const srt = installCountingSrt();
    const backend = createSrtBackend({});

    await backend.wrap(ledgerRequest("a"));
    backend.commandFinished();

    expect({ wraps: srt.wraps(), cleanups: srt.cleanups() }).toEqual({ wraps: 1, cleanups: 1 });
    expect(existsSync(ledgerDir)).toBe(false);
  });

  test("US-003 AC8: an unconfigured credential store still wraps and writes no ledger", async () => {
    _placeholderDeps.ledgerDir = () => {
      throw new NaxError("Credentials are not configured", "CREDENTIALS_NOT_CONFIGURED", { stage: "credentials" });
    };
    installCountingSrt({ argv: ["true"] });
    const backend = createSrtBackend({});

    await expect(backend.wrap(ledgerRequest("a"))).resolves.toEqual(["true"]);
    // wrap consulted the ledger, found none, and said so once.
    expect(callsAt("debug", "sandbox: placeholder ledger disabled").length).toBe(1);
    expect(existsSync(ledgerDir)).toBe(false);
  });

  test("US-003 AC9: an unwritable ledger file still lets wrap resolve its argv", async () => {
    installCountingSrt({ argv: ["true"] });
    mkdirSync(processLedgerPath(), { recursive: true });
    const backend = createSrtBackend({});

    await expect(backend.wrap(ledgerRequest("a"))).resolves.toEqual(["true"]);
    // The write was attempted and failed once, without reaching the caller.
    expect(callsAt("warn", "sandbox: placeholder ledger write failed").length).toBe(1);
    expect(lstatSync(processLedgerPath()).isDirectory()).toBe(true);
  });

  /**
   * #2986 — bwrap creates its placeholders when the wrapped process SPAWNS, which
   * is after `wrap` resolves. `commandStarted` is the hook the launcher calls once
   * the argv is running; it identifies the placeholders with a bounded retry, so a
   * process killed mid-command still leaves identified entries behind.
   */
  describe("commandStarted (#2986)", () => {
    const INTERVAL = 20;
    const MAX = 2000;
    let queue: { fn: () => void; ms: number; cancelled: boolean }[];

    function installManualTimer(): void {
      queue = [];
      _srtBackendDeps.startedPollIntervalMs = INTERVAL;
      _srtBackendDeps.startedPollMaxMs = MAX;
      _srtBackendDeps.schedule = (fn, ms) => {
        const item = { fn, ms, cancelled: false };
        queue.push(item);
        return () => {
          item.cancelled = true;
        };
      };
    }

    /** Fire the oldest live timer, as the event loop would. */
    function tick(): boolean {
      const next = queue.find((item) => !item.cancelled);
      if (next === undefined) return false;
      next.cancelled = true;
      next.fn();
      return true;
    }

    function pendingTimers(): number {
      return queue.filter((item) => !item.cancelled).length;
    }

    test("identifies a placeholder that appears after wrap, without commandFinished", async () => {
      installCountingSrt();
      installManualTimer();
      const backend = createSrtBackend({});
      const target = join(cwd, ".zprofile");
      await backend.wrap(ledgerRequest("a"));
      expect(ledgerEntries()).toContainEqual({ path: target });

      // The wrapped process spawns and bwrap creates the mount points.
      makePlaceholderFile(target);
      backend.commandStarted?.();
      tick();

      const stats = lstatSync(target);
      expect(ledgerEntries()).toContainEqual({ path: target, kind: "file", dev: stats.dev, ino: stats.ino });
    });

    test("retries while a candidate is still absent, then stops once none is pending", async () => {
      installCountingSrt();
      installManualTimer();
      const backend = createSrtBackend({});
      const everyCandidate = async () => {
        await backend.wrap(ledgerRequest("a"));
        return ledgerPaths();
      };
      const paths = await everyCandidate();
      backend.commandStarted?.();
      expect(pendingTimers()).toBe(1);

      // First poll: bwrap has not created anything yet, so another poll is queued.
      tick();
      expect(pendingTimers()).toBe(1);

      // bwrap now creates every candidate; the next poll identifies them all.
      for (const path of paths) {
        mkdirSync(join(path, ".."), { recursive: true });
        makePlaceholderFile(path);
      }
      tick();
      expect(ledgerEntries().every((entry) => entry.ino !== undefined)).toBe(true);
      expect(pendingTimers()).toBe(0);
    });

    test("gives up after the cap when a candidate never appears", async () => {
      installCountingSrt();
      installManualTimer();
      const backend = createSrtBackend({});
      await backend.wrap(ledgerRequest("a"));
      backend.commandStarted?.();

      let polls = 0;
      while (tick()) polls += 1;

      expect(polls).toBe(MAX / INTERVAL);
      expect(pendingTimers()).toBe(0);
    });

    test("commandFinished stops the polling", async () => {
      installCountingSrt();
      installManualTimer();
      const backend = createSrtBackend({});
      await backend.wrap(ledgerRequest("a"));
      backend.commandStarted?.();
      expect(pendingTimers()).toBe(1);

      backend.commandFinished();

      expect(pendingTimers()).toBe(0);
    });

    test("a command that is still running keeps the poll alive when another one finishes", async () => {
      installCountingSrt();
      installManualTimer();
      const backend = createSrtBackend({});
      await backend.wrap(ledgerRequest("a"));
      await backend.wrap(ledgerRequest("b"));
      backend.commandStarted?.();
      backend.commandStarted?.();

      backend.commandFinished();

      expect(pendingTimers()).toBe(1);
    });

    test("a commandFinished for a command that never started leaves another command's poll alone", async () => {
      installCountingSrt();
      installManualTimer();
      const backend = createSrtBackend({});
      await backend.wrap(ledgerRequest("a"));
      await backend.wrap(ledgerRequest("b"));
      backend.commandStarted?.("a");

      // `b` was wrapped but its runArgv returned early (aborted signal): finished, never started.
      backend.commandFinished("b");
      expect(pendingTimers()).toBe(1);

      backend.commandFinished("a");
      expect(pendingTimers()).toBe(0);
    });

    test("a scheduler that throws never fails the command", async () => {
      installCountingSrt();
      installManualTimer();
      _srtBackendDeps.schedule = () => {
        throw new Error("no timers");
      };
      const backend = createSrtBackend({});
      await backend.wrap(ledgerRequest("a"));

      expect(() => backend.commandStarted?.()).not.toThrow();
      expect(callsAt("warn", "sandbox: placeholder identification after spawn failed").length).toBe(1);
    });

    test("on darwin it schedules nothing", async () => {
      _srtBackendDeps.platform = () => "darwin";
      _placeholderDeps.platform = () => "darwin";
      installCountingSrt();
      installManualTimer();
      const backend = createSrtBackend({});
      await backend.wrap(ledgerRequest("a"));

      backend.commandStarted?.();

      expect(pendingTimers()).toBe(0);
    });
  });
});
