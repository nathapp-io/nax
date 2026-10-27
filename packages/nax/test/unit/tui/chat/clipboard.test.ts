import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { _clipboardDeps, copyToClipboard, osc52 } from "@/tui/chat/clipboard";

const original = { ..._clipboardDeps };
const write = mock((_text: string): void => {});
const spawnCopy = mock(async (_text: string): Promise<number> => 0);
beforeEach(() => {
  write.mockClear();
  spawnCopy.mockClear();
  Object.assign(_clipboardDeps, { write, spawnCopy, platform: "linux" });
});
afterEach(() => Object.assign(_clipboardDeps, original));
describe("osc52", () => {
  test("AC-15 encodes hi", () => expect(osc52("hi")).toBe("\u001b]52;c;aGk=\u0007"));
  test("encodes UTF-8", () => expect(osc52("😀")).toBe("\u001b]52;c;8J+YgA==\u0007"));
});
describe("pbcopy wrapper", () => {
  test.each([0, 1])("passes UTF-8 on stdin and returns exit code %i", async (exitCode) => {
    const spawn = mock((_command: string[], _options: Parameters<typeof _clipboardDeps.spawn>[1]) => ({
      exited: Promise.resolve(exitCode),
    }));
    _clipboardDeps.spawn = spawn;
    _clipboardDeps.spawnCopy = original.spawnCopy;
    _clipboardDeps.platform = "darwin";

    await expect(original.spawnCopy("hello 😀")).resolves.toBe(exitCode);
    expect(spawn.mock.calls).toEqual([
      [["pbcopy"], { stdin: new TextEncoder().encode("hello 😀"), stdout: "ignore", stderr: "ignore" }],
    ]);
    await expect(copyToClipboard("hello 😀")).resolves.toBeUndefined();
    expect(write.mock.calls).toEqual([[osc52("hello 😀")]]);
  });
});
describe("copyToClipboard", () => {
  test("AC-16 writes OSC52", async () => {
    await copyToClipboard("hi");
    expect(write.mock.calls).toEqual([[osc52("hi")]]);
  });
  test("AC-17 no linux subprocess", async () => {
    await copyToClipboard("hi");
    expect(spawnCopy).not.toHaveBeenCalled();
  });
  test("AC-18 macOS writes before pbcopy", async () => {
    _clipboardDeps.platform = "darwin";
    _clipboardDeps.spawnCopy = async (text) => {
      expect(write.mock.calls).toEqual([[osc52(text)]]);
      return spawnCopy(text);
    };
    await copyToClipboard("hi");
    expect(spawnCopy.mock.calls).toEqual([["hi"]]);
  });
  test("AC-19 rejected pbcopy resolves", async () => {
    _clipboardDeps.platform = "darwin";
    _clipboardDeps.spawnCopy = async () => {
      throw new Error("unavailable");
    };
    await expect(copyToClipboard("hi")).resolves.toBeUndefined();
    expect(write.mock.calls).toEqual([[osc52("hi")]]);
  });
  test("AC-20 nonzero pbcopy resolves", async () => {
    _clipboardDeps.platform = "darwin";
    _clipboardDeps.spawnCopy = async () => 1;
    await expect(copyToClipboard("hi")).resolves.toBeUndefined();
    expect(write.mock.calls).toEqual([[osc52("hi")]]);
  });
});
