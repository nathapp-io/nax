/**
 * Unit tests for src/utils/command-argv.ts
 *
 * A minimal shell-like tokenizer: splits on whitespace, honors single/double
 * quoting, handles backslash escapes inside double quotes, and expands a
 * leading `~/` to $HOME.
 */

import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { parseCommandToArgv } from "@/utils/command-argv";

describe("parseCommandToArgv", () => {
  test("splits a simple space-separated command", () => {
    expect(parseCommandToArgv("bun test src/index.ts")).toEqual(["bun", "test", "src/index.ts"]);
  });

  test("collapses runs of spaces and tabs between tokens", () => {
    expect(parseCommandToArgv("bun  \t test")).toEqual(["bun", "test"]);
  });

  test("trims leading and trailing whitespace", () => {
    expect(parseCommandToArgv("  bun test  ")).toEqual(["bun", "test"]);
  });

  test("returns an empty array for an empty or whitespace-only command", () => {
    expect(parseCommandToArgv("")).toEqual([]);
    expect(parseCommandToArgv("   ")).toEqual([]);
  });

  test("keeps single-quoted content as one token, including inner spaces", () => {
    expect(parseCommandToArgv("echo 'hello world'")).toEqual(["echo", "hello world"]);
  });

  test("keeps double-quoted content as one token, including inner spaces", () => {
    expect(parseCommandToArgv('echo "hello world"')).toEqual(["echo", "hello world"]);
  });

  test("does not interpret escapes inside single quotes", () => {
    expect(parseCommandToArgv("echo 'a\\\"b'")).toEqual(["echo", 'a\\"b']);
  });

  test('unescapes \\" inside double quotes', () => {
    expect(parseCommandToArgv('echo "say \\"hi\\""')).toEqual(["echo", 'say "hi"']);
  });

  test("unescapes \\\\ inside double quotes", () => {
    expect(parseCommandToArgv('echo "a\\\\b"')).toEqual(["echo", "a\\b"]);
  });

  test("leaves a backslash before a non-quote/backslash character untouched inside double quotes", () => {
    expect(parseCommandToArgv('echo "a\\nb"')).toEqual(["echo", "a\\nb"]);
  });

  test("merges a quoted segment adjoining an unquoted segment into one token", () => {
    expect(parseCommandToArgv('echo foo"bar baz"qux')).toEqual(["echo", "foobar bazqux"]);
  });

  test("handles an unterminated single quote by consuming to end of input", () => {
    expect(parseCommandToArgv("echo 'unterminated")).toEqual(["echo", "unterminated"]);
  });

  test("handles an unterminated double quote by consuming to end of input", () => {
    expect(parseCommandToArgv('echo "unterminated')).toEqual(["echo", "unterminated"]);
  });

  test("does not emit a token for an empty quoted segment", () => {
    // current.length > 0 gates the push, so an empty quoted token is dropped.
    expect(parseCommandToArgv("echo '' next")).toEqual(["echo", "next"]);
  });

  test("expands a leading ~/ to $HOME on an unquoted token", () => {
    expect(parseCommandToArgv("cat ~/notes.txt")).toEqual(["cat", `${homedir()}/notes.txt`]);
  });

  test("expands ~/ inside a quoted token as well", () => {
    expect(parseCommandToArgv('cat "~/notes.txt"')).toEqual(["cat", `${homedir()}/notes.txt`]);
  });

  test("does not expand a bare ~ with no trailing slash", () => {
    expect(parseCommandToArgv("echo ~")).toEqual(["echo", "~"]);
  });

  test("does not expand ~ in the middle of a token", () => {
    expect(parseCommandToArgv("echo a~/b")).toEqual(["echo", "a~/b"]);
  });

  test("parses multiple quoted arguments with mixed quote styles", () => {
    expect(parseCommandToArgv(`run --name 'my task' --path "/tmp/some dir"`)).toEqual([
      "run",
      "--name",
      "my task",
      "--path",
      "/tmp/some dir",
    ]);
  });
});
