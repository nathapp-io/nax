/**
 * nax#2551: `\<newline>` is a line continuation — sh removes both characters, outside quotes and
 * inside double quotes (single quotes keep it literal). The lexer must read the word sh runs, or a
 * policy judges `r\<NL>m` while sh executes `rm`.
 */
import { describe, expect, test } from "bun:test";
import { lexBashCommand } from "#src/permissions/index";

function words(command: string): string[][] {
  const result = lexBashCommand(command);
  if (result.kind !== "ok") throw new Error(`expected ok, got refused: ${result.construct}`);
  return result.segments.map((s) => s.tokens.map((t) => t.text));
}

/** The argv sh itself builds for `command`, one word per line (no word here holds a newline). */
function shWords(command: string): string[] {
  const out = Bun.spawnSync(["/bin/sh", "-c", `set -- ${command}; for w in "$@"; do printf '%s\\n' "$w"; done`]);
  return out.stdout.toString().split("\n").slice(0, -1);
}

const BS = "\\";
const NL = "\n";

const CASES = [
  "r\\\nm -rf x",
  "cat .g\\\nit/config",
  "cat .\\\n./.\\\n./etc/hosts",
  "echo a \\\n b",
  'echo ".g\\\nit/hooks"',
  "echo 'a\\\nb'",
  `echo "a${BS}${BS}${NL}b"`,
];

describe("line continuation (nax#2551)", () => {
  test("outside quotes, backslash-newline joins the word", () => {
    expect(words("r\\\nm -rf x")).toEqual([["rm", "-rf", "x"]]);
    expect(words("cat .g\\\nit/config")).toEqual([["cat", ".git/config"]]);
  });

  test("between words it starts no word of its own", () => {
    expect(words("echo a \\\n b")).toEqual([["echo", "a", "b"]]);
  });

  test("inside double quotes it is removed too", () => {
    expect(words('echo ".g\\\nit/hooks"')).toEqual([["echo", ".git/hooks"]]);
  });

  test("an escaped backslash before a newline is no continuation", () => {
    // `\\` is one escaped backslash, so the newline after it is kept, as sh keeps it.
    expect(words(`echo "a${BS}${BS}${NL}b"`)).toEqual([["echo", `a${BS}${NL}b`]]);
  });

  test("a continuation cannot split `$(` inside double quotes", () => {
    const result = lexBashCommand(`echo "$${BS}${NL}(id)"`);
    expect(result.kind).toBe("refused");
  });

  test("inside single quotes it stays literal", () => {
    expect(words("echo 'a\\\nb'")).toEqual([["echo", "a\\\nb"]]);
  });

  test.each(CASES)("the lexer reads the words sh runs: %p", (command) => {
    const lexed = words(command).flat();
    const expected = shWords(command);
    // `shWords` splits on newlines, so a word that keeps one (single quotes) is compared rejoined.
    expect(lexed.join("\n")).toBe(expected.join("\n"));
  });
});
