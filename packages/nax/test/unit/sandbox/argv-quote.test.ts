import { describe, expect, test } from "bun:test";
import { quoteArgvForShell } from "@/sandbox";

/** Round trip through a REAL /bin/sh: the only proof that quoting is exact. */
function roundTrip(argv: readonly string[]): string[] {
  const script = `${quoteArgvForShell(argv)}`;
  // printf '%s\0' prints each argument NUL-terminated, so the split is exact.
  const proc = Bun.spawnSync(["/bin/sh", "-c", `printf '%s\\0' ${script}`]);
  const out = proc.stdout.toString();
  return out.length === 0 ? [] : out.slice(0, -1).split("\0");
}

const CORPUS: readonly (readonly string[])[] = [
  ["bun", "add", "left-pad"],
  ["echo", "it's"],
  ["echo", "a'b'c", "''", "'"],
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell syntax is the input under test
  ["echo", "$(touch /tmp/nax-pwned)", "`id`", "${HOME}", "$HOME"],
  ["echo", "a;b", "a&&b", "a|b", "a>b", "a<b", "a&"],
  ["echo", "line1\nline2", "tab\there"],
  ["echo", "*", "?", "[a-z]", "{a,b}", "~"],
  ["echo", "-n", "--flag=value", "-"],
  ["echo", ""],
  ["echo", "héllo", "日本語", "emoji-free"],
  ["echo", "back\\slash", "\\'"],
];

describe("quoteArgvForShell", () => {
  test.each(CORPUS.map((argv) => [argv.join(" | "), argv] as const))("round-trips exactly: %s", (_label, argv) => {
    expect(roundTrip(argv)).toEqual([...argv].slice(0));
  });

  test("never lets a metacharacter execute", () => {
    roundTrip(["echo", "$(touch /tmp/nax-p4-quote-canary)"]);
    expect(Bun.file("/tmp/nax-p4-quote-canary").size).toBe(0);
  });

  test("wraps every element, even a plain word", () => {
    expect(quoteArgvForShell(["bun", "test"])).toBe("'bun' 'test'");
  });
});
