import { describe, expect, mock, test } from "bun:test";
import * as resources from "@/resources";

describe("runCommandShellLines", () => {
  test("AC-4 AC-5 runs in order and concatenates literal segments", async () => {
    const calls: string[] = [];
    const result = await resources.runCommandShellLines("A !`ls` B !`pwd`", async (command) => {
      calls.push(command);
      return { isError: false, content: `<${command} output>` };
    });
    expect(calls).toEqual(["ls", "pwd"]);
    expect(result).toEqual({ text: "A <ls output> B <pwd output>" });
  });
  test("AC-6 AC-7 leaves text without shell lines untouched without running", async () => {
    const run = mock(async () => ({ isError: false, content: "unused" }));
    expect(await resources.runCommandShellLines("plain text", run)).toEqual({ text: "plain text" });
    expect(run).not.toHaveBeenCalled();
  });
  test("AC-8 AC-9 inserts dollar patterns and shell syntax literally without rescanning", async () => {
    const run = mock(async (_command: string) => ({ isError: false, content: "$& !`rm x`" }));
    expect(await resources.runCommandShellLines("!`ls`", run)).toEqual({ text: "$& !`rm x`" });
    expect(run.mock.calls).toEqual([["ls"]]);
  });
  test("AC-10 AC-11 stops on an error result and uses its first line", async () => {
    const run = mock(async (_command: string) => ({ isError: true, content: "denied\nmore" }));
    expect(await resources.runCommandShellLines("!`ls` !`pwd`", run)).toEqual({
      failed: { command: "ls", reason: "denied" },
    });
    expect(run.mock.calls).toEqual([["ls"]]);
  });
  test("AC-12 returns the rejection message", async () => {
    const run = mock(async (_command: string) => {
      throw new Error("busy");
    });
    expect(await resources.runCommandShellLines("!`ls` !`pwd`", run)).toEqual({
      failed: { command: "ls", reason: "busy" },
    });
    expect(run.mock.calls).toEqual([["ls"]]);
  });
  test.each(["!``", "!`line\nbreak`", "unclosed !`ls"])("ignores nonmatching syntax: %s", async (text) => {
    const run = mock(async () => ({ isError: false, content: "unused" }));
    expect(await resources.runCommandShellLines(text, run)).toEqual({ text });
    expect(run).not.toHaveBeenCalled();
  });
});
