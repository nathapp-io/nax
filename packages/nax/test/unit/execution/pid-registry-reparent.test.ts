/**
 * M21 — a descendant whose parent already exited on SIGTERM is reparented to
 * init (ppid 1). The tree kill identifies a snapshotted process by pid and
 * start time, so a reparented descendant still receives SIGTERM and SIGKILL.
 *
 * Split from `pid-registry.test.ts` (640 lines) by concern, per the
 * `<module>-<concern>.test.ts` split rule.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { cleanupTempDir, makeLogger, makeSpawn, makeTempDir, withDepsRestore } from "@test/helpers";
import { _pidRegistryDeps, PidRegistry } from "@/execution";
import * as loggerModule from "@/logger";

withDepsRestore(_pidRegistryDeps, ["spawn", "sleep"]);

const ROOT_PID = 172446;
const CHILD_PID = 172468;
const DESCENDANT_PID = 172469;

const ROOT_STARTED_AT = "Thu May 15 11:52:44 2026";
const CHILD_STARTED_AT = "Thu May 15 11:52:45 2026";
const DESCENDANT_STARTED_AT = "Thu May 15 11:52:46 2026";
const REUSED_STARTED_AT = "Thu May 15 11:59:59 2026";

/** The `ps -eo pid=,ppid=,lstart=` snapshot the tree kill walks. */
const PS_SNAPSHOT = [
  `${ROOT_PID} 1 ${ROOT_STARTED_AT}`,
  `${CHILD_PID} ${ROOT_PID} ${CHILD_STARTED_AT}`,
  `${DESCENDANT_PID} ${CHILD_PID} ${DESCENDANT_STARTED_AT}`,
  "",
].join("\n");

let TEST_WORKDIR: string;

beforeEach(() => {
  TEST_WORKDIR = makeTempDir("nax-pid-registry-reparent-");
});

afterEach(() => cleanupTempDir(TEST_WORKDIR));

interface LookupResult {
  stdout: string;
  exitCode: number;
}

/**
 * Stub the ps/kill subprocesses.
 *
 * `descendantLookup` answers the per-pid `ps -o ppid=,lstart= -p <D>` call.
 * `attempt` counts that pid's lookups: 0 is the SIGTERM pass, 1 the SIGKILL
 * pass. Every other pid answers with its snapshotted identity.
 */
function stubRegistry(calls: string[][], descendantLookup: (attempt: number) => LookupResult): void {
  const attempts = new Map<string, number>();
  const identities: Record<string, string> = {
    [String(ROOT_PID)]: `1 ${ROOT_STARTED_AT}\n`,
    [String(CHILD_PID)]: `${ROOT_PID} ${CHILD_STARTED_AT}\n`,
  };

  _pidRegistryDeps.spawn = makeSpawn(({ cmd }) => {
    calls.push(cmd);
    if (cmd[0] === "ps" && cmd[1] === "-eo") {
      return { stdout: PS_SNAPSHOT, exitCode: 0 };
    }
    if (cmd[0] === "ps" && cmd[1] === "-o") {
      const pid = cmd[4] ?? "";
      if (pid === String(DESCENDANT_PID)) {
        const attempt = attempts.get(pid) ?? 0;
        attempts.set(pid, attempt + 1);
        return descendantLookup(attempt);
      }
      const identity = identities[pid];
      return identity ? { stdout: identity, exitCode: 0 } : { stdout: "", exitCode: 1 };
    }
    return { exitCode: 0 };
  }).spawn;
  _pidRegistryDeps.sleep = async () => {};
}

describe("PidRegistry — reparented descendants (M21)", () => {
  test("killAll() sends SIGTERM to a descendant reparented to init", async () => {
    const calls: string[][] = [];
    stubRegistry(calls, () => ({ stdout: `1 ${DESCENDANT_STARTED_AT}\n`, exitCode: 0 }));

    const registry = new PidRegistry(TEST_WORKDIR);
    await registry.register(ROOT_PID);
    await registry.killAll();

    expect(calls).toContainEqual(["kill", "-TERM", String(DESCENDANT_PID)]);
    // The rest of the tree is still signalled — the reparented descendant is
    // not singled out for special treatment.
    expect(calls).toContainEqual(["kill", "-TERM", String(CHILD_PID)]);
    expect(calls).toContainEqual(["kill", "-TERM", String(ROOT_PID)]);
  });

  test("killAll() sends SIGKILL to a descendant reparented to init", async () => {
    const calls: string[][] = [];
    stubRegistry(calls, () => ({ stdout: `1 ${DESCENDANT_STARTED_AT}\n`, exitCode: 0 }));

    const registry = new PidRegistry(TEST_WORKDIR);
    await registry.register(ROOT_PID);
    await registry.killAll();

    expect(calls).toContainEqual(["kill", "-KILL", String(DESCENDANT_PID)]);
  });

  test("killAll() sends SIGKILL to a descendant reparented between the SIGTERM and SIGKILL passes", async () => {
    const calls: string[][] = [];
    stubRegistry(calls, (attempt) =>
      attempt === 0
        ? { stdout: `${CHILD_PID} ${DESCENDANT_STARTED_AT}\n`, exitCode: 0 }
        : { stdout: `1 ${DESCENDANT_STARTED_AT}\n`, exitCode: 0 },
    );

    const registry = new PidRegistry(TEST_WORKDIR);
    await registry.register(ROOT_PID);
    await registry.killAll();

    expect(calls).toContainEqual(["kill", "-TERM", String(DESCENDANT_PID)]);
    expect(calls).toContainEqual(["kill", "-KILL", String(DESCENDANT_PID)]);
  });

  test("killAll() skips a descendant whose start time changed (PID reuse)", async () => {
    const calls: string[][] = [];
    stubRegistry(calls, () => ({ stdout: `${CHILD_PID} ${REUSED_STARTED_AT}\n`, exitCode: 0 }));

    const registry = new PidRegistry(TEST_WORKDIR);
    await registry.register(ROOT_PID);
    await registry.killAll();

    expect(calls).not.toContainEqual(["kill", "-TERM", String(DESCENDANT_PID)]);
    expect(calls).not.toContainEqual(["kill", "-KILL", String(DESCENDANT_PID)]);
  });

  test("killAll() warns once with both start times when the PID was reused", async () => {
    const logger = makeLogger();
    const spy = spyOn(loggerModule, "getSafeLogger").mockReturnValue(logger);
    const calls: string[][] = [];
    stubRegistry(calls, () => ({ stdout: `${CHILD_PID} ${REUSED_STARTED_AT}\n`, exitCode: 0 }));

    try {
      const registry = new PidRegistry(TEST_WORKDIR);
      await registry.register(ROOT_PID);
      await registry.killAll();

      const skipWarns = logger.calls.filter(
        (call) =>
          call.level === "warn" && call.stage === "pid-registry" && call.message.startsWith("Skipping SIGTERM for PID"),
      );
      expect(skipWarns.length).toBe(1);
      expect(skipWarns[0]?.data?.expectedStartedAt).toBe(DESCENDANT_STARTED_AT);
      expect(skipWarns[0]?.data?.currentStartedAt).toBe(REUSED_STARTED_AT);
    } finally {
      spy.mockRestore();
    }
  });

  test("killAll() sends no signal when the descendant's identity lookup fails", async () => {
    const calls: string[][] = [];
    stubRegistry(calls, () => ({ stdout: "", exitCode: 1 }));

    const registry = new PidRegistry(TEST_WORKDIR);
    await registry.register(ROOT_PID);
    await registry.killAll();

    expect(calls).not.toContainEqual(["kill", "-TERM", String(DESCENDANT_PID)]);
    expect(calls).not.toContainEqual(["kill", "-KILL", String(DESCENDANT_PID)]);
  });
});
