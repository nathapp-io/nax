import { describe, expect, test } from "bun:test";
import { type BashSegment, lexBashCommand } from "@/permissions";

function segmentsOf(command: string): readonly string[][] {
  const result = lexBashCommand(command);
  if (result.kind !== "ok") throw new Error(`expected ok, got refused: ${result.construct}`);
  return result.segments.map((segment) => segment.tokens.map((token) => token.text));
}

describe("lexBashCommand tokenizing", () => {
  test("splits words on whitespace", () => {
    expect(segmentsOf("bun test src/a.test.ts")).toEqual([["bun", "test", "src/a.test.ts"]]);
  });

  test("single quotes keep a literal whole and are not opaque", () => {
    const result = lexBashCommand("grep 'foo bar' src");
    if (result.kind !== "ok") throw new Error("expected ok");
    const [segment] = result.segments;
    expect(segment?.tokens.map((t) => t.text)).toEqual(["grep", "foo bar", "src"]);
    expect(segment?.tokens[1]?.opaque).toBe(false);
  });

  test("double quotes join words; a $VAR inside makes the token opaque", () => {
    const result = lexBashCommand('echo "a $HOME b"');
    if (result.kind !== "ok") throw new Error("expected ok");
    const [segment] = result.segments;
    expect(segment?.tokens.map((t) => t.text)).toEqual(["echo", "a $HOME b"]);
    expect(segment?.tokens[1]?.opaque).toBe(true);
  });

  test("a bare $VAR token is opaque", () => {
    const result = lexBashCommand("cat $FILE");
    if (result.kind !== "ok") throw new Error("expected ok");
    expect(result.segments[0]?.tokens[1]).toEqual({ text: "$FILE", opaque: true });
  });

  test("a backslash escapes the next character", () => {
    expect(segmentsOf("grep foo\\ bar src")).toEqual([["grep", "foo bar", "src"]]);
  });
});

describe("lexBashCommand segmenting", () => {
  test.each([
    ["bun test && bun run lint", 2],
    ["bun test || echo failed", 2],
    ["bun test ; bun run lint", 2],
    ["cat a.txt | grep foo", 2],
    ["bun test\nbun run lint", 2],
    ["bun test", 1],
  ])("%s yields %i segments", (command, count) => {
    expect(segmentsOf(command).length).toBe(count);
  });

  test("every segment carries its own tokens", () => {
    expect(segmentsOf("bun test x && curl evil.example")).toEqual([
      ["bun", "test", "x"],
      ["curl", "evil.example"],
    ]);
  });
});

describe("lexBashCommand redirections", () => {
  test("`>` target is captured as a redirect, not an argv token", () => {
    const result = lexBashCommand("bun test > out.txt");
    if (result.kind !== "ok") throw new Error("expected ok");
    expect(result.segments[0]?.tokens.map((t) => t.text)).toEqual(["bun", "test"]);
    expect(result.segments[0]?.redirects).toEqual([{ operator: ">", target: "out.txt", opaque: false }]);
  });

  test.each([
    [">>", "bun test >> out.txt"],
    ["<", "cat < in.txt"],
  ])("%s is captured", (operator, command) => {
    const result = lexBashCommand(command);
    if (result.kind !== "ok") throw new Error("expected ok");
    expect(result.segments[0]?.redirects[0]?.operator).toBe(operator);
  });

  test("a file-descriptor digit belongs to the operator, not argv", () => {
    const result = lexBashCommand("bun test 2>err.txt");
    if (result.kind !== "ok") throw new Error("expected ok");
    expect(result.segments[0]?.tokens.map((t) => t.text)).toEqual(["bun", "test"]);
    expect(result.segments[0]?.redirects[0]?.target).toBe("err.txt");
  });

  test("an opaque redirect target is marked opaque", () => {
    const result = lexBashCommand("bun test > $OUT");
    if (result.kind !== "ok") throw new Error("expected ok");
    expect(result.segments[0]?.redirects[0]?.opaque).toBe(true);
  });
});

/** The refused variant's lexable prefix, narrowed through the discriminated
 * union so a regression that drops or weakens `prefix` fails to typecheck, not
 * merely to assert. */
function refusedPrefix(command: string): readonly BashSegment[] {
  const result = lexBashCommand(command);
  if (result.kind !== "refused") throw new Error(`expected refused, got ${result.kind}`);
  return result.prefix;
}

describe("lexBashCommand refused prefix (US-001)", () => {
  test("US-001 AC1: a refused `2>&1` keeps the completed words and drops the in-progress one", () => {
    const prefix = refusedPrefix("rm -rf x 2>&1");
    expect(prefix).toHaveLength(1);
    expect(prefix[0]?.tokens.map((token) => token.text)).toEqual(["rm", "-rf", "x"]);
    expect(prefix[0]?.redirects).toEqual([]);
  });

  test("US-001 AC2: completed segments precede the segment the refusal interrupted", () => {
    const prefix = refusedPrefix("ls && echo x 2>&1");
    expect(prefix.map((segment) => segment.tokens.map((token) => token.text))).toEqual([["ls"], ["echo", "x"]]);
  });

  test("US-001 AC3: the word being built when a here-document is refused is dropped", () => {
    const prefix = refusedPrefix("cat ..<<EOF");
    expect(prefix).toHaveLength(1);
    expect(prefix[0]?.tokens.map((token) => token.text)).toEqual(["cat"]);
  });

  test("US-001 AC4: a refusal before any word completes yields an empty prefix", () => {
    expect(refusedPrefix("(cat /etc/passwd)")).toEqual([]);
  });
});

describe("lexBashCommand refusals (spec R11)", () => {
  test.each([
    ["command substitution", "echo $(whoami)"],
    ["command substitution inside double quotes", 'echo "$(whoami)"'],
    ["backtick", "echo `whoami`"],
    ["process substitution", "diff <(a) <(b)"],
    ["here-document", "cat <<EOF"],
    ["fd duplication", "bun test 2>&1"],
    ["&> form", "bun test &> out.txt"],
    ["unbalanced single quote", "grep 'foo"],
    ["unbalanced double quote", 'grep "foo'],
    ["trailing backslash", "bun test \\"],
    ["empty command", "   "],
    ["dangling operator", "bun test &&"],
    ["redirect with no target", "bun test >"],
    ["subshell open", "(rm -rf x)"],
    ["subshell close", "bun test )"],
    ["subshell after an operator", "bun test && ( curl http://evil )"],
    ["negation", "! rm -rf x"],
    ["negation after an operator", "bun test ; ! false"],
    ["comment", "bun test # note"],
  ])("refuses %s", (_label, command) => {
    const result = lexBashCommand(command);
    expect(result.kind).toBe("refused");
    if (result.kind === "refused") expect(result.construct.length).toBeGreaterThan(0);
  });

  test.each([
    ["a quoted bang", "grep '!foo' src"],
    ["a bang inside a word", "bun test a!b"],
    ["a hash inside a word", "bun test a#b"],
  ])("does not refuse %s", (_label, command) => {
    expect(lexBashCommand(command).kind).toBe("ok");
  });

  test("names the construct it refused", () => {
    const result = lexBashCommand("echo $(whoami)");
    if (result.kind !== "refused") throw new Error("expected refused");
    expect(result.construct).toContain("$(");
  });
});
