/**
 * The policy files Cursor and pi read (SPEC-cursor-pi-acp-read-only US-004). Each
 * one is content-addressed — the first 16 hex characters of the SHA-256 of its
 * body — and atomic: written to a temporary name in its target directory, then
 * renamed over the target, on every launch.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { writeCursorPolicy, writePiFile } from "#src/client/policy-files";
import { rejection, sessionError } from "#test/helpers/errors";
import { stubPolicyDeps } from "#test/helpers/policy-deps";

/** Every deps call, as ["mkdir", path, options] and so on, in the order it happened. */
let io: readonly (readonly unknown[])[] = [];
let restore: () => void = () => {};

/** Records every deps call; `fail` makes that one operation reject. */
function stubDeps(fail?: "mkdir" | "writeFile" | "chmod" | "rename"): void {
  const recorder = stubPolicyDeps(fail);
  io = recorder.io;
  restore = recorder.restore;
}

afterEach(() => {
  restore();
  restore = () => {};
  io = [];
});

/** sha256("x") and sha256("hello world"), from the OS's own sha256sum. */
const H_X = "2d711642b726b044";
const H_HELLO = "b94d27b9934d3e08";

describe("writeCursorPolicy: Cursor's isolated cli-config.json (AC-11, AC-12)", () => {
  test("AC-11: mkdir, write, chmod, then rename over the content-addressed target", async () => {
    stubDeps();
    await writeCursorPolicy("/state", "x");
    const dir = `/state/cursor/${H_X}`;
    const target = `${dir}/cli-config.json`;
    expect(io[0]).toEqual(["mkdir", dir, { recursive: true, mode: 0o700 }]);
    const temp = io[1]?.[1];
    expect(typeof temp).toBe("string");
    expect(`${temp}`.startsWith(`${dir}/`)).toBe(true);
    expect(temp).not.toBe(target);
    expect(io[1]).toEqual(["writeFile", temp, "x"]);
    expect(io[2]).toEqual(["chmod", temp, 0o600]);
    expect(io[3]).toEqual(["rename", temp, target]);
    expect(io).toHaveLength(4);
  });

  test("AC-12: the directory it returns is the one holding the config", async () => {
    stubDeps();
    expect(await writeCursorPolicy("/state", "hello world")).toBe(`/state/cursor/${H_HELLO}`);
    expect(io.at(-1)).toEqual(["rename", expect.any(String), `/state/cursor/${H_HELLO}/cli-config.json`]);
  });
});

describe("writePiFile: pi's gate extension and wrapper (AC-13, AC-14, AC-15)", () => {
  test("AC-13: mkdir of the pi directory, then write, chmod and rename of the hashed file", async () => {
    stubDeps();
    await writePiFile("/state", "wrapper", "hello world", 0o700);
    const target = `/state/pi/wrapper-${H_HELLO}.sh`;
    expect(io[0]).toEqual(["mkdir", "/state/pi", { recursive: true, mode: 0o700 }]);
    const temp = io[1]?.[1];
    expect(typeof temp).toBe("string");
    expect(`${temp}`.startsWith("/state/pi/")).toBe(true);
    expect(temp).not.toBe(target);
    expect(io[1]).toEqual(["writeFile", temp, "hello world"]);
    expect(io[2]).toEqual(["chmod", temp, 0o700]);
    expect(io[3]).toEqual(["rename", temp, target]);
    expect(io).toHaveLength(4);
  });

  test("AC-14: the wrapper's path and the gate extension's own name and extension", async () => {
    stubDeps();
    expect(await writePiFile("/state", "wrapper", "hello world", 0o700)).toBe(`/state/pi/wrapper-${H_HELLO}.sh`);
    expect(await writePiFile("/state", "shell-gate", "hello world", 0o600)).toBe(`/state/pi/shell-gate-${H_HELLO}.ts`);
    expect(io[2]).toEqual(["chmod", expect.any(String), 0o700]);
    expect(io[3]).toEqual(["rename", expect.any(String), `/state/pi/wrapper-${H_HELLO}.sh`]);
    expect(io[6]).toEqual(["chmod", expect.any(String), 0o600]);
    expect(io[7]).toEqual(["rename", expect.any(String), `/state/pi/shell-gate-${H_HELLO}.ts`]);
  });

  test("AC-15: the same content is written and renamed again, over whatever is already there", async () => {
    stubDeps();
    const first = await writePiFile("/state", "wrapper", "hello world", 0o700);
    const second = await writePiFile("/state", "wrapper", "hello world", 0o700);
    expect(second).toBe(first);
    expect(io).toHaveLength(8);
    expect(io.filter((call) => call[0] === "rename")).toHaveLength(2);
    expect(io.filter((call) => call[0] === "writeFile")).toHaveLength(2);
  });

  test("each write uses its own temporary name: a racing open cannot clobber the other's file", async () => {
    stubDeps();
    await writePiFile("/state", "wrapper", "hello world", 0o700);
    await writePiFile("/state", "wrapper", "hello world", 0o700);
    const temps = io.filter((call) => call[0] === "writeFile").map((call) => call[1]);
    expect(temps).toHaveLength(2);
    expect(temps[0]).not.toBe(temps[1]);
  });
});

describe("a failed write (AC-34, AC-35)", () => {
  test.each(["mkdir", "writeFile", "chmod", "rename"] as const)(
    "a rejecting %s refuses the write, naming the policy path",
    async (op) => {
      stubDeps(op);
      const err = sessionError(await rejection(writeCursorPolicy("/state", "x")));
      expect(err.code).toBe("AGENT_SESSION_BACKEND_UNAVAILABLE");
      expect(err.message).toContain(`/state/cursor/${H_X}/cli-config.json`);
      expect(err.context).toMatchObject({ path: `/state/cursor/${H_X}/cli-config.json` });
    },
  );

  test("pi's wrapper names its own path", async () => {
    stubDeps("rename");
    const err = sessionError(await rejection(writePiFile("/state", "wrapper", "hello world", 0o700)));
    expect(err.code).toBe("AGENT_SESSION_BACKEND_UNAVAILABLE");
    expect(err.message).toContain(`/state/pi/wrapper-${H_HELLO}.sh`);
  });
});
