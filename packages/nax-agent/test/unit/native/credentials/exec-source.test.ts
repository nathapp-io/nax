/**
 * US-003 — the exec credential source.
 *
 * The helper contract is a process boundary, so these tests exercise it the way
 * koda will: a small executable script in a temp dir, spawned without a shell.
 * Each fake helper records its own run count, its argv and the stdin it read, so
 * "spawned again" / "did not spawn" is an observable file rather than an internal
 * call count.
 *
 * `NAX_GLOBAL_CONFIG_DIR` is pointed at the same fresh temp dir in every test,
 * per the story's harness note, so nothing can reach the developer's real `~/.nax`.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { NaxError } from "@nathapp/nax-agent/internal";
import {
  AUTH_HELPER_STDERR_MAX_BYTES,
  AUTH_HELPER_STDOUT_MAX_BYTES,
  createExecCredentialSource,
  LEASE_FRESHNESS_MS,
} from "@nathapp/nax-agent/internal";
import { getSafeLogger, setAgentLogger } from "#src/infra/index";
import {
  assertNaxError,
  cleanupTempDir,
  type LogCall,
  makeLogger,
  makeTempDir,
  withTimerSpy,
} from "#test/helpers/index";

type ExecSource = ReturnType<typeof createExecCredentialSource>;

interface HelperSpec {
  /** Credential/decline reply printed verbatim to stdout. */
  stdout?: string;
  /** Print this file's contents to stdout instead — for over-cap payloads. */
  stdoutFile?: string;
  stderr?: string;
  exitCode?: number;
  /** Delay before replying — a healthy but slow helper. */
  sleepSeconds?: number;
  /** Stay alive forever after producing output — a helper that never exits. */
  busyLoop?: boolean;
}

interface FakeHelper {
  /** The executable the source is told to run. */
  script: string;
  command: string[];
  set(spec: HelperSpec): void;
  /** How many times the helper has been spawned. */
  runCount(): number;
  /** `$0` followed by the args the helper was spawned with. */
  argv(): string[];
  /** What the helper read from stdin, trimmed. */
  stdin(): string;
}

/**
 * The helper executable's own path is created once for the whole file, not per
 * test: exec'ing a path the OS has not seen before costs ~370ms here (macOS),
 * against ~9ms for a rewrite of a path already exec'd. Each test still gets its
 * own capture files, and `set()` rewrites the script in place, so behaviour is
 * per-test while the wall clock stays sane.
 */
let scriptsDir: string;
let helperScript: string;

beforeAll(() => {
  scriptsDir = makeTempDir("nax-exec-source-scripts-");
  helperScript = join(scriptsDir, "fake-helper.sh");
});

afterAll(() => {
  cleanupTempDir(scriptsDir);
});

function makeFakeHelper(captureDir: string): FakeHelper {
  const script = helperScript;
  const runsPath = join(captureDir, "runs.txt");
  const argvPath = join(captureDir, "argv.txt");
  const stdinPath = join(captureDir, "stdin.txt");

  const set = (spec: HelperSpec): void => {
    const lines = [
      "#!/bin/sh",
      `echo run >> '${runsPath}'`,
      `printf '%s\\n' "$0" "$@" > '${argvPath}'`,
      // Always drain stdin first: nax writes the request line and closes the
      // pipe, and a helper that exits without reading it can make that write
      // fail with EPIPE before the behaviour under test is reached.
      `cat > '${stdinPath}'`,
    ];
    if (spec.sleepSeconds !== undefined) lines.push(`sleep ${spec.sleepSeconds}`);
    if (spec.stdoutFile !== undefined) lines.push(`cat '${spec.stdoutFile}'`);
    if (spec.stdout !== undefined) lines.push(`printf '%s' '${spec.stdout}'`);
    if (spec.stderr !== undefined) lines.push(`printf '%s' '${spec.stderr}' >&2`);
    if (spec.busyLoop === true) lines.push("while true; do :; done");
    lines.push(`exit ${spec.exitCode ?? 0}`);
    writeFileSync(script, `${lines.join("\n")}\n`);
    chmodSync(script, 0o755);
  };

  set({ stdout: "" });

  return {
    script,
    command: [script],
    set,
    runCount: () => (existsSync(runsPath) ? readFileSync(runsPath, "utf8").trim().split("\n").length : 0),
    argv: () => readFileSync(argvPath, "utf8").trim().split("\n"),
    stdin: () => readFileSync(stdinPath, "utf8").trim(),
  };
}

/** A well-formed credential reply, optionally carrying `expiresAt`/`account`. */
function credentialReply(key: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ version: 1, kind: "api-key", key, ...extra });
}

const DECLINE_REPLY = JSON.stringify({ version: 1, decline: true });

let dir: string;
let helper: FakeHelper;
let logger: ReturnType<typeof makeLogger>;
const originalGlobalDir = process.env.NAX_GLOBAL_CONFIG_DIR;
const originalLogger = getSafeLogger();

beforeEach(() => {
  dir = makeTempDir("nax-exec-source-");
  process.env.NAX_GLOBAL_CONFIG_DIR = dir;
  helper = makeFakeHelper(dir);

  logger = makeLogger();
  setAgentLogger(logger);
});

afterEach(() => {
  setAgentLogger(originalLogger);
  process.env.NAX_GLOBAL_CONFIG_DIR = originalGlobalDir;
  cleanupTempDir(dir);
});

function sourceFor(target: FakeHelper = helper, timeoutMs?: number, now?: () => number): ExecSource {
  return createExecCredentialSource({
    command: target.command,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(now === undefined ? {} : { now }),
  });
}

/** `read` is expected to reject; returns the caught error, narrowed for assertions. */
async function readError(source: ExecSource, providerId = "anthropic"): Promise<NaxError> {
  try {
    await source.read(providerId);
  } catch (err) {
    assertNaxError(err, "read rejection");
    return err;
  }
  throw new Error(`expected read("${providerId}") to reject, but it resolved`);
}

/** Entries whose event name (the log message) equals `name`. */
function named(name: string): LogCall[] {
  return logger.calls.filter((entry) => entry.message === name);
}

/**
 * Every run of `LEAK_MIN_RUN` consecutive characters of `secret` that `haystack`
 * contains — the fragments a message would carry if it echoed part of the
 * helper's stdout. A whole-message equality check would be brittle; this asserts
 * the one thing that matters (no verbatim stdout reached the message) without
 * pinning the message's fixed wording.
 */
const LEAK_MIN_RUN = 8;
function leakedFragments(haystack: string, secret: string): string[] {
  const found: string[] = [];
  for (let i = 0; i + LEAK_MIN_RUN <= secret.length; i++) {
    const fragment = secret.slice(i, i + LEAK_MIN_RUN);
    if (haystack.includes(fragment) && !found.includes(fragment)) found.push(fragment);
  }
  return found;
}

describe("createExecCredentialSource", () => {
  describe("helper invocation", () => {
    test('AC1: read spawns the helper with argv [script, "get"]', async () => {
      helper.set({ stdout: credentialReply("HELPER-KEY") });

      await sourceFor().read("anthropic");

      expect(helper.argv()).toEqual([helper.script, "get"]);
    });

    test('AC2: the helper receives stdin {"version":1,"providerId":"anthropic"}', async () => {
      helper.set({ stdout: credentialReply("HELPER-KEY") });

      await sourceFor().read("anthropic");

      // Parsed, not string-matched: the contract is one JSON request line, and
      // key order is not part of it.
      expect(JSON.parse(helper.stdin())).toEqual({ version: 1, providerId: "anthropic" });
    });

    test("AC2 boundary: the request line names the provider that was asked for", async () => {
      helper.set({ stdout: credentialReply("HELPER-KEY") });

      await sourceFor().read("openai");

      expect(JSON.parse(helper.stdin())).toEqual({ version: 1, providerId: "openai" });
    });
  });

  describe("credential replies", () => {
    test('AC3: read returns { kind: "api-key", key: "HELPER-KEY" } for a credential reply', async () => {
      helper.set({ stdout: credentialReply("HELPER-KEY") });

      const credential = await sourceFor().read("anthropic");

      expect(credential).toEqual({ kind: "api-key", key: "HELPER-KEY" });
    });

    test("AC3 boundary: an empty key makes read throw CREDENTIAL_HELPER_INVALID", async () => {
      helper.set({ stdout: credentialReply("") });

      const err = await readError(sourceFor());

      expect(err.code).toBe("CREDENTIAL_HELPER_INVALID");
    });
  });

  describe("lease cache", () => {
    test("AC4: a second read of a lease with no expiresAt returns it without spawning again", async () => {
      helper.set({ stdout: credentialReply("HELPER-KEY") });
      const source = sourceFor();

      const first = await source.read("anthropic");
      const second = await source.read("anthropic");

      expect(second).toEqual(first);
      expect(helper.runCount()).toBe(1);
    });

    test("AC5: a lease whose expiresAt is 30 seconds away is not fresh, so the next read spawns again", async () => {
      helper.set({ stdout: credentialReply("HELPER-KEY", { expiresAt: Date.now() + 30_000 }) });
      const source = sourceFor();

      await source.read("anthropic");
      await source.read("anthropic");

      expect(helper.runCount()).toBe(2);
    });

    test("AC6: a lease whose expiresAt is 5 minutes away returns without spawning", async () => {
      helper.set({ stdout: credentialReply("HELPER-KEY", { expiresAt: Date.now() + 300_000 }) });
      const source = sourceFor();

      const first = await source.read("anthropic");
      const second = await source.read("anthropic");

      expect(second).toEqual(first);
      expect(helper.runCount()).toBe(1);
    });

    test.each([
      { distance: "just over", expiresIn: LEASE_FRESHNESS_MS + 5_000, expectedRuns: 1 },
      { distance: "just under", expiresIn: LEASE_FRESHNESS_MS - 5_000, expectedRuns: 2 },
    ])(
      "LEASE_FRESHNESS_MS boundary: a lease $distance the window is $expectedRuns spawn(s)",
      async ({ expiresIn, expectedRuns }) => {
        helper.set({ stdout: credentialReply("HELPER-KEY", { expiresAt: Date.now() + expiresIn }) });
        const source = sourceFor();

        await source.read("anthropic");
        await source.read("anthropic");

        expect(helper.runCount()).toBe(expectedRuns);
      },
    );

    test("AC7: two concurrent reads for one provider with no lease spawn the helper exactly once", async () => {
      // The helper takes 300ms to answer, so both reads are provably in flight
      // together; single-flight, not luck, is what keeps the run count at one.
      helper.set({ stdout: credentialReply("HELPER-KEY"), sleepSeconds: 0.3 });
      const source = sourceFor(helper, 4_000);

      const [first, second] = await Promise.all([source.read("anthropic"), source.read("anthropic")]);

      expect(first).toEqual({ kind: "api-key", key: "HELPER-KEY" });
      expect(second).toEqual(first);
      expect(helper.runCount()).toBe(1);
    });
  });

  describe("decline", () => {
    test("AC8: a decline reply makes read return undefined", async () => {
      helper.set({ stdout: DECLINE_REPLY });

      const credential = await sourceFor().read("anthropic");

      expect(credential).toBeUndefined();
    });

    test("AC9: after a decline, a second read returns undefined without spawning", async () => {
      helper.set({ stdout: DECLINE_REPLY });
      const source = sourceFor();
      await source.read("anthropic");

      const second = await source.read("anthropic");

      expect(second).toBeUndefined();
      expect(helper.runCount()).toBe(1);
    });

    test("AC23: with an expired lease, a decline reply makes read throw CREDENTIAL_HELPER_INVALID", async () => {
      const clock = { t: Date.now() };
      const expiry = clock.t + 1_000;
      helper.set({ stdout: credentialReply("SHORT-KEY", { expiresAt: expiry }) });
      const source = sourceFor(helper, undefined, () => clock.t);
      await source.read("anthropic");
      clock.t = expiry + 1;
      helper.set({ stdout: DECLINE_REPLY });

      const err = await readError(source);

      expect(err.code).toBe("CREDENTIAL_HELPER_INVALID");
    });
  });

  describe("helper failures", () => {
    test("AC10: a helper exiting 1 with no lease held makes read throw CREDENTIAL_HELPER_FAILED", async () => {
      helper.set({ exitCode: 1, stderr: "boom" });

      const err = await readError(sourceFor());

      expect(err.code).toBe("CREDENTIAL_HELPER_FAILED");
    });

    test("AC11: a helper still running at timeoutMs makes read throw CREDENTIAL_HELPER_FAILED", async () => {
      helper.set({ busyLoop: true });
      const source = sourceFor(helper, 200);

      const err = await readError(source);

      expect(err.code).toBe("CREDENTIAL_HELPER_FAILED");
    });

    test("AC11 boundary: the timeout failure logs credential.helper_failed with timedOut true", async () => {
      helper.set({ busyLoop: true });
      const source = sourceFor(helper, 200);

      await readError(source);

      const failed = named("credential.helper_failed");
      expect(failed).toHaveLength(1);
      expect(failed[0].data).toMatchObject({
        providerId: "anthropic",
        code: "CREDENTIAL_HELPER_FAILED",
        timedOut: true,
        servedLastGood: false,
      });
    });

    test("AC12: a command naming a non-existent binary makes read throw CREDENTIAL_HELPER_FAILED", async () => {
      const source = createExecCredentialSource({ command: [join(dir, "no-such-helper")] });

      const err = await readError(source);

      expect(err.code).toBe("CREDENTIAL_HELPER_FAILED");
    });

    test("AC13: a helper exiting 1 with no lease held logs credential.helper_failed with servedLastGood false", async () => {
      helper.set({ exitCode: 1, stderr: "boom" });

      await readError(sourceFor());

      const failed = named("credential.helper_failed");
      expect(failed).toHaveLength(1);
      expect(failed[0].data).toMatchObject({
        providerId: "anthropic",
        code: "CREDENTIAL_HELPER_FAILED",
        exitCode: 1,
        servedLastGood: false,
      });
    });

    test("AC11 boundary: the timeout timer is cleared when the process exits", async () => {
      helper.set({ stdout: credentialReply("HELPER-KEY") });
      const source = sourceFor();

      const { leaked } = await withTimerSpy(async () => {
        await source.read("anthropic");
      });

      expect(leaked).toEqual([]);
    });

    test("Secrets: stderr is redacted before it is truncated, so no key fragment reaches the log", async () => {
      // The secret starts 16 bytes before the truncation point: truncating first
      // would leave "sk-" plus a 13-character fragment, which the redaction
      // patterns (16+ characters after "sk-") can no longer recognise.
      const secret = "sk-abcdefghijklmnopqrstuvwxyz0123";
      helper.set({ exitCode: 1, stderr: `${"x".repeat(AUTH_HELPER_STDERR_MAX_BYTES - 16)}${secret}` });

      await readError(sourceFor());

      const failed = named("credential.helper_failed");
      expect(failed).toHaveLength(1);
      expect(JSON.stringify(failed[0])).not.toContain("sk-");
    });

    test("AUTH_HELPER_STDERR_MAX_BYTES: a long stderr excerpt is truncated to the cap", async () => {
      helper.set({ exitCode: 1, stderr: "x".repeat(AUTH_HELPER_STDERR_MAX_BYTES * 2) });

      await readError(sourceFor());

      const serialized = JSON.stringify(named("credential.helper_failed")[0]);
      const runs = (serialized.match(/x+/g) ?? []).map((run) => run.length);
      expect(runs.length).toBeGreaterThan(0);
      expect(Math.max(...runs)).toBeLessThanOrEqual(AUTH_HELPER_STDERR_MAX_BYTES);
    });
  });

  describe("malformed replies", () => {
    test.each([
      { ac: "AC14", label: 'kind "oauth"', stdout: JSON.stringify({ version: 1, kind: "oauth", key: "K" }) },
      { ac: "AC15", label: "non-JSON stdout", stdout: "definitely not json" },
      { ac: "AC16", label: "version 2", stdout: JSON.stringify({ version: 2, kind: "api-key", key: "K" }) },
      {
        ac: "AC17",
        label: "an expiresAt earlier than now",
        stdout: JSON.stringify({ version: 1, kind: "api-key", key: "K", expiresAt: Date.now() - 1_000 }),
      },
      {
        ac: "AC17",
        label: "an expiresAt of 0",
        stdout: JSON.stringify({ version: 1, kind: "api-key", key: "K", expiresAt: 0 }),
      },
      {
        ac: "boundary",
        label: "an account that is not a string",
        stdout: JSON.stringify({ version: 1, kind: "api-key", key: "K", account: 7 }),
      },
      {
        ac: "boundary",
        label: "an account over 200 characters",
        stdout: JSON.stringify({ version: 1, kind: "api-key", key: "K", account: "a".repeat(201) }),
      },
      {
        ac: "boundary",
        label: "a key over 8,192 characters",
        stdout: JSON.stringify({ version: 1, kind: "api-key", key: "k".repeat(8_193) }),
      },
    ])("$ac: a reply with $label makes read throw CREDENTIAL_HELPER_INVALID", async ({ stdout }) => {
      helper.set({ stdout });

      const err = await readError(sourceFor());

      expect(err.code).toBe("CREDENTIAL_HELPER_INVALID");
    });

    test("AC18: a helper writing more than AUTH_HELPER_STDOUT_MAX_BYTES bytes to stdout makes read throw CREDENTIAL_HELPER_INVALID", async () => {
      const overCap = join(dir, "over-cap.json");
      writeFileSync(overCap, "a".repeat(AUTH_HELPER_STDOUT_MAX_BYTES + 1));
      helper.set({ stdoutFile: overCap, busyLoop: true });
      const source = sourceFor(helper, 2_000);

      const err = await readError(source);

      expect(err.code).toBe("CREDENTIAL_HELPER_INVALID");
    });

    test("AC18 boundary: a reply of exactly AUTH_HELPER_STDOUT_MAX_BYTES bytes is accepted", async () => {
      const reply = credentialReply("HELPER-KEY");
      helper.set({ stdout: reply + " ".repeat(AUTH_HELPER_STDOUT_MAX_BYTES - reply.length) });

      const credential = await sourceFor().read("anthropic");

      expect(credential).toEqual({ kind: "api-key", key: "HELPER-KEY" });
    });

    // Review finding (2026-09-30): JSON.parse's message quotes the text it failed
    // on, so a non-JSON reply used to carry a fragment of stdout into the thrown
    // NaxError message — and from there into `nax auth list` and the precheck
    // report. The spec's Secrets rule is that stdout is never logged.
    test("review: a non-JSON reply that is a bare key leaks no 8-character fragment of it", async () => {
      const stdout = "ghp_A1b2C3d4E5f6G7h8I9j0KLMNOPQRSTuVWXyZ0123";
      helper.set({ stdout });

      const err = await readError(sourceFor());

      expect(err.code).toBe("CREDENTIAL_HELPER_INVALID");
      expect(leakedFragments(err.message, stdout)).toEqual([]);
    });

    test("review: a JSON reply that is not an object also leaks no stdout fragment", async () => {
      const stdout = '"sk-a-b-c-d-e-f-g-h-i-j-k-l-m-n-o-p"';
      helper.set({ stdout });

      const err = await readError(sourceFor());

      expect(err.code).toBe("CREDENTIAL_HELPER_INVALID");
      expect(leakedFragments(err.message, stdout)).toEqual([]);
    });

    // The two above cover the non-JSON parse path. `version` and `kind` were the
    // other two: both helper-controlled and unvalidated, so echoing either with
    // JSON.stringify copied an arbitrary subtree of stdout into the message.
    test.each([
      { label: "kind", stdout: '{"version":1,"kind":{"key":"ghp_A1b2C3d4E5f6G7h8I9j0KLMNOPQRSTuVWXyZ0123"}}' },
      {
        label: "version",
        stdout: '{"version":{"key":"ghp_A1b2C3d4E5f6G7h8I9j0KLMNOPQRSTuVWXyZ0123"},"kind":"api-key","key":"K"}',
      },
      { label: "a string kind", stdout: '{"version":1,"kind":"ghp_A1b2C3d4E5f6G7h8I9j0KLMNOPQRSTuVWXyZ0123"}' },
    ])("review: a reply whose $label carries a key leaks no fragment of it", async ({ stdout }) => {
      helper.set({ stdout });

      const err = await readError(sourceFor());

      expect(err.code).toBe("CREDENTIAL_HELPER_INVALID");
      expect(leakedFragments(err.message, stdout)).toEqual([]);
    });
  });

  describe("last good lease", () => {
    test("AC19: with a last good lease 30 seconds away, a helper exiting 1 makes read return that lease", async () => {
      helper.set({ stdout: credentialReply("LONG-KEY", { expiresAt: Date.now() + 30_000 }) });
      const source = sourceFor();
      const lease = await source.read("anthropic");
      helper.set({ exitCode: 1 });

      const served = await source.read("anthropic");

      expect(served).toEqual(lease);
    });

    test("AC20: with a last good lease 30 seconds away, a helper exiting 1 logs servedLastGood true", async () => {
      helper.set({ stdout: credentialReply("LONG-KEY", { expiresAt: Date.now() + 30_000 }) });
      const source = sourceFor();
      await source.read("anthropic");
      logger.reset();
      helper.set({ exitCode: 1 });

      await source.read("anthropic");

      const failed = named("credential.helper_failed");
      expect(failed).toHaveLength(1);
      expect(failed[0].data).toMatchObject({ servedLastGood: true, providerId: "anthropic" });
    });

    test("AC21: with a last good lease that has expired, a helper exiting 1 makes read throw CREDENTIAL_HELPER_FAILED", async () => {
      const clock = { t: Date.now() };
      const expiry = clock.t + 1_000;
      helper.set({ stdout: credentialReply("SHORT-KEY", { expiresAt: expiry }) });
      const source = sourceFor(helper, undefined, () => clock.t);
      await source.read("anthropic");
      clock.t = expiry + 1;
      helper.set({ exitCode: 1 });

      const err = await readError(source);

      expect(err.code).toBe("CREDENTIAL_HELPER_FAILED");
    });

    test("AC22: two consecutive failed reads served from the last good lease log credential.helper_failed exactly once", async () => {
      helper.set({ stdout: credentialReply("LONG-KEY", { expiresAt: Date.now() + 30_000 }) });
      const source = sourceFor();
      await source.read("anthropic");
      logger.reset();
      helper.set({ exitCode: 1 });

      await source.read("anthropic");
      await source.read("anthropic");

      expect(named("credential.helper_failed")).toHaveLength(1);
    });
  });

  describe("accountOf, modify and delete", () => {
    test("accountOf returns the current lease's account label", async () => {
      helper.set({ stdout: credentialReply("HELPER-KEY", { account: "koda:proj-42/anthropic-team" }) });
      const source = sourceFor();

      await source.read("anthropic");

      expect(source.accountOf("anthropic")).toBe("koda:proj-42/anthropic-team");
    });

    test("accountOf returns undefined before any read and for a lease without an account", async () => {
      helper.set({ stdout: credentialReply("HELPER-KEY") });
      const source = sourceFor();
      const before = source.accountOf("anthropic");

      await source.read("anthropic");

      expect(before).toBeUndefined();
      expect(source.accountOf("anthropic")).toBeUndefined();
    });

    test("modify throws NaxError code CREDENTIAL_MANAGED_BY_HELPER", async () => {
      const source = sourceFor();

      try {
        await source.modify("anthropic", async () => undefined);
      } catch (err) {
        assertNaxError(err, "modify rejection");
        expect(err.code).toBe("CREDENTIAL_MANAGED_BY_HELPER");
        return;
      }
      throw new Error("expected modify to reject");
    });

    test("delete throws NaxError code CREDENTIAL_MANAGED_BY_HELPER", async () => {
      const source = sourceFor();

      try {
        await source.delete("anthropic");
      } catch (err) {
        assertNaxError(err, "delete rejection");
        expect(err.code).toBe("CREDENTIAL_MANAGED_BY_HELPER");
        return;
      }
      throw new Error("expected delete to reject");
    });
  });
});

/**
 * US-004 re-asserts two of the helper's guarantees at the assembly boundary,
 * because the chained store and the run-start probe both reach them through the
 * exec source. The redaction contract matters here: a helper's stderr is the one
 * free-text channel a key can travel on.
 */
describe("createExecCredentialSource — US-004 acceptance", () => {
  test("US-004 AC8: the CREDENTIAL_HELPER_FAILED message omits a secret the helper wrote to stderr", async () => {
    helper.set({ exitCode: 1, stderr: "api_key=sk-secret123" });

    const err = await readError(sourceFor());

    expect(err.code).toBe("CREDENTIAL_HELPER_FAILED");
    expect(err.message).not.toContain("sk-secret123");
    // The redacted excerpt is also carried on the log entry and the error
    // context, so a leak either way would still reach the run log.
    expect(JSON.stringify(named("credential.helper_failed"))).not.toContain("sk-secret123");
    expect(JSON.stringify(err.context ?? {})).not.toContain("sk-secret123");
  });

  test("US-004 AC9: delete(provider) throws NaxError code CREDENTIAL_MANAGED_BY_HELPER", async () => {
    const source = sourceFor();

    try {
      await source.delete("anthropic");
    } catch (err) {
      assertNaxError(err, "delete rejection");
      expect(err.code).toBe("CREDENTIAL_MANAGED_BY_HELPER");
      return;
    }
    throw new Error("expected delete to reject");
  });
});
