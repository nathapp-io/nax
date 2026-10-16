import { describe, expect, test } from "bun:test";
import { lexBashCommand } from "#src/permissions/index";
import { canonicalSegments } from "#src/tools/bash-canonical";

function canonical(command: string) {
  const lexed = lexBashCommand(command);
  if (lexed.kind !== "ok" || lexed.segments[0] === undefined) throw new Error("invalid fixture");
  return canonicalSegments(lexed.segments[0]);
}

function texts(command: string) {
  const result = canonical(command);
  expect(result.kind).toBe("ok");
  if (result.kind !== "ok") throw new Error(result.reason);
  return result.segments.map((segment) => segment.tokens.map((token) => token.text));
}

// Single-quote shell text without changing its meaning at the next nesting level.
function shell(command: string): string {
  return `sh -c '${command.replaceAll("'", "'\\''")}'`;
}

describe("canonical Bash segments", () => {
  test.each([
    [1, "env FOO=1 rm -rf x", [["rm", "-rf", "x"]]],
    [2, "FOO=1 BAR=2 rm x", [["rm", "x"]]],
    [3, "time nohup nice -n 5 rm x", [["rm", "x"]]],
    [4, "xargs -n 1 rm", [["rm"]]],
    [5, "busybox rm x", [["rm", "x"]]],
    [7, "git -C . -c a=b --no-pager push origin", [["git", "push", "origin"]]],
    [8, "sh -c 'rm -rf x'", [["rm", "-rf", "x"]]],
    [9, "bash -lc 'rm x'", [["rm", "x"]]],
    [
      10,
      "bash -c 'echo a; rm x'",
      [
        ["echo", "a"],
        ["rm", "x"],
      ],
    ],
    [12, "then rm x", [["rm", "x"]]],
    [13, "fi", []],
    [14, "bash -o pipefail -c 'rm x'", [["rm", "x"]]],
    [15, "bash --norc -c 'rm x'", [["rm", "x"]]],
  ] as const)("AC-%i: %s", (_ac, command, expected) => {
    expect(texts(command)).toEqual(expected.map((tokens) => [...tokens]));
  });

  test.each([
    "env -i -u NAME -- FOO=1 rm x",
    "command -p exec -a name -cl rm x",
    "timeout --foreground --signal=TERM -k 2 5 rm x",
    "stdbuf -oL -i 0 --error=L rm x",
    "xargs -0 -I {} -P 2 -d : -E end -L 1 -s 100 rm x",
    "sudo -nE --user=root -g wheel doas -n -u user rm x",
    "git --git-dir=. --work-tree . --namespace ns --bare --literal-pathspecs --no-replace-objects push x",
  ])("wrapper and git option tables: %s", (command) => {
    const expected = command.startsWith("git") ? ["git", "push", "x"] : ["rm", "x"];
    expect(texts(command)).toEqual([expected]);
  });
  test.each(["command", "exec", "time", "nohup", "nice", "timeout", "stdbuf", "xargs", "busybox", "sudo", "doas"])(
    "unknown %s option is refused",
    (wrapper) => {
      expect(canonical(`${wrapper} --frobnicate rm x`).kind).toBe("refused");
    },
  );
  test.each(["exec -a", "env -u", "timeout", "sh -c", "sh -c '$CMD'", "sh -c 'echo $(id)'"])(
    "unreadable or incomplete command is refused: %s",
    (command) => {
      expect(canonical(command).kind).toBe("refused");
    },
  );
  test("shell plus-options do not hide a subsequent command string", () => {
    expect(texts("bash +e +o pipefail -c 'rm x'")).toEqual([["rm", "x"]]);
  });
  test("shell option values are not mistaken for command-string flags", () => {
    expect(texts("bash --rcfile -c -ec 'rm x'")).toEqual([["rm", "x"]]);
    expect(texts("bash script -c 'rm x'")).toEqual([["bash", "script", "-c", "rm x"]]);
  });
  test("canonical views retain token opacity and do not mutate the raw segment", () => {
    const lexed = lexBashCommand("env rm $TARGET > out");
    if (lexed.kind !== "ok" || lexed.segments[0] === undefined) throw new Error("invalid fixture");
    const segment = lexed.segments[0];
    const result = canonicalSegments(segment);
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.segments[0]?.tokens[1]).toEqual({ text: "$TARGET", opaque: true });
      expect(result.segments[0]?.redirects).toEqual(segment.redirects);
    }
    expect(segment.tokens.map((token) => token.text)).toEqual(["env", "rm", "$TARGET"]);
  });
  test.each(["done", "}"])("bare closer %s is dropped", (command) => {
    expect(texts(command)).toEqual([]);
  });

  test("AC-6: unknown wrapper option is refused", () => {
    expect(canonical("env --frobnicate rm x").kind).toBe("refused");
  });
  test("AC-11: fourth nested shell is refused; third is readable", () => {
    const three = shell(shell(shell("rm x")));
    expect(texts(three)).toEqual([["rm", "x"]]);
    expect(canonical(shell(three)).kind).toBe("refused");
  });
});
