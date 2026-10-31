import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  _clipboardImageDeps,
  CLIPBOARD_READ_TIMEOUT_MS,
  type ClipboardImage,
  type ClipboardRun,
  readClipboardImage,
} from "@/tui/chat/clipboard-image";

const original = { ..._clipboardImageDeps };
/** The real runner, captured before any test replaces the seam. */
const defaultRun = _clipboardImageDeps.run;

const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);
const exited = (stdout: Uint8Array | string, exitCode = 0): ClipboardRun => ({
  kind: "exited",
  exitCode,
  stdout: typeof stdout === "string" ? bytesOf(stdout) : stdout,
});

const run = mock(async (_argv: readonly string[], _timeoutMs: number): Promise<ClipboardRun> => exited(""));

function resolveWith(result: ClipboardRun): void {
  run.mockImplementation(async () => result);
}

beforeEach(() => {
  run.mockClear();
  run.mockImplementation(async () => exited(""));
  Object.assign(_clipboardImageDeps, {
    platform: "darwin",
    env: () => ({}),
    run,
  });
});

afterEach(() => void Object.assign(_clipboardImageDeps, original));

describe("CLIPBOARD_READ_TIMEOUT_MS", () => {
  test("AC-1 is 2000 ms", () => {
    expect(CLIPBOARD_READ_TIMEOUT_MS).toBe(2000);
  });
});

describe("the deps seam", () => {
  test("defaults to the process platform and environment", () => {
    expect(original.platform).toBe(process.platform);
    expect(original.env()).toBe(process.env);
  });
});

describe("readClipboardImage on darwin", () => {
  beforeEach(() => {
    _clipboardImageDeps.platform = "darwin";
  });

  test("AC-1 runs osascript once with the read timeout", async () => {
    await readClipboardImage();

    expect(run.mock.calls).toEqual([[["osascript", "-e", "the clipboard as «class PNGf»"], CLIPBOARD_READ_TIMEOUT_MS]]);
  });

  test("AC-2 decodes the PNG hex digits from an osascript exit 0", async () => {
    resolveWith(exited("«data PNGf89504E47»\n"));

    const result: ClipboardImage = await readClipboardImage();

    expect(result).toEqual({ kind: "image", bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) });
  });

  test("AC-3 returns none on a non-zero exit", async () => {
    resolveWith(exited("«data PNGf89504E47»", 1));

    await expect(readClipboardImage()).resolves.toEqual({ kind: "none" });
  });

  test("AC-4 returns none when exit 0 holds no PNG data", async () => {
    resolveWith(exited("the clipboard holds text\n"));

    await expect(readClipboardImage()).resolves.toEqual({ kind: "none" });
  });

  test("AC-2 decodes lowercase hex digits too", async () => {
    resolveWith(exited("«data PNGf89504e47»\n"));

    await expect(readClipboardImage()).resolves.toEqual({
      kind: "image",
      bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    });
  });
});

describe("readClipboardImage on linux", () => {
  beforeEach(() => {
    _clipboardImageDeps.platform = "linux";
  });

  test("AC-5 uses wl-paste under Wayland and returns its stdout", async () => {
    _clipboardImageDeps.env = () => ({ WAYLAND_DISPLAY: "wayland-0" });
    const stdout = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d]);
    resolveWith(exited(stdout));

    await expect(readClipboardImage()).resolves.toEqual({ kind: "image", bytes: stdout });
    expect(run.mock.calls).toEqual([[["wl-paste", "--no-newline", "--type", "image/png"], CLIPBOARD_READ_TIMEOUT_MS]]);
  });

  test.each([
    ["unset", {}],
    ["empty", { WAYLAND_DISPLAY: "" }],
  ])("AC-6 uses xclip when WAYLAND_DISPLAY is %s", async (_label, env) => {
    _clipboardImageDeps.env = () => env;

    await readClipboardImage();

    expect(run.mock.calls).toEqual([
      [["xclip", "-selection", "clipboard", "-t", "image/png", "-o"], CLIPBOARD_READ_TIMEOUT_MS],
    ]);
  });

  test("AC-7 returns none on an empty stdout", async () => {
    resolveWith(exited(new Uint8Array()));

    await expect(readClipboardImage()).resolves.toEqual({ kind: "none" });
  });

  test("AC-7 returns none on a non-zero exit", async () => {
    resolveWith(exited(new Uint8Array([0x89]), 1));

    await expect(readClipboardImage()).resolves.toEqual({ kind: "none" });
  });
});

describe("readClipboardImage on an unsupported platform", () => {
  test("AC-8 returns unsupported on win32 and never runs a command", async () => {
    _clipboardImageDeps.platform = "win32";

    await expect(readClipboardImage()).resolves.toEqual({ kind: "unsupported" });
    expect(run).not.toHaveBeenCalled();
  });
});

describe("readClipboardImage failures", () => {
  test("AC-9 reports a missing command with its name", async () => {
    _clipboardImageDeps.platform = "linux";
    _clipboardImageDeps.env = () => ({});
    resolveWith({ kind: "missing" });

    await expect(readClipboardImage()).resolves.toEqual({
      kind: "failed",
      reason: "xclip is not installed",
    });
  });

  test("AC-9 names osascript on darwin", async () => {
    _clipboardImageDeps.platform = "darwin";
    resolveWith({ kind: "missing" });

    await expect(readClipboardImage()).resolves.toEqual({
      kind: "failed",
      reason: "osascript is not installed",
    });
  });

  test("AC-10 reports a timed-out read", async () => {
    resolveWith({ kind: "timed-out" });

    await expect(readClipboardImage()).resolves.toEqual({
      kind: "failed",
      reason: "clipboard read timed out",
    });
  });

  test("AC-11 reports the rejection message", async () => {
    run.mockImplementation(async () => {
      throw new Error("boom");
    });

    await expect(readClipboardImage()).resolves.toEqual({ kind: "failed", reason: "boom" });
  });
});

describe("the default runner", () => {
  test("AC-12 resolves missing for an executable that is not on PATH", async () => {
    await expect(defaultRun(["nax-no-such-command-xyz"], 1000)).resolves.toEqual({
      kind: "missing",
    });
  });

  test("AC-13 resolves timed-out and kills a child that outlives the timeout", async () => {
    const startedAt = performance.now();

    await expect(defaultRun(["sleep", "5"], 50)).resolves.toEqual({ kind: "timed-out" });

    expect(performance.now() - startedAt).toBeLessThan(2_000);
  });

  test("AC-14 captures the stdout of a command that exits 0", async () => {
    const result = await defaultRun(["printf", "abc"], 1_000);

    expect(result).toEqual({ kind: "exited", exitCode: 0, stdout: bytesOf("abc") });
  });

  test("AC-13 keeps the timeout when a grandchild holds the stdout pipe open", async () => {
    const startedAt = performance.now();

    await expect(defaultRun(["sh", "-c", "printf abc; sleep 5"], 50)).resolves.toEqual({
      kind: "timed-out",
    });

    expect(performance.now() - startedAt).toBeLessThan(2_000);
  });
});
