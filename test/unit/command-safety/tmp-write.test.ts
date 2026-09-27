import { describe, expect, test } from "bun:test";
import { detectTmpWrite } from "@/command-safety";

describe("detectTmpWrite", () => {
  test("US-005 AC1: a redirect into a literal /tmp path is a write", () => {
    expect(detectTmpWrite("echo x > /tmp/a.txt")).toBe(true);
  });

  test("US-005 AC2: a here-document refusal still scans the lexable prefix, after a `cd /tmp`", () => {
    const command = "cd /tmp && cat > tsconfig.json <<'EOF'\n{}\nEOF";
    expect(detectTmpWrite(command)).toBe(true);
  });

  test("US-005 AC3: tee's non-flag argument is a write target", () => {
    expect(detectTmpWrite("tee /tmp/out.log")).toBe(true);
  });

  test("US-005 AC4: cp's last non-flag argument is a write target under /private/tmp", () => {
    expect(detectTmpWrite("cp src/a.ts /private/tmp/")).toBe(true);
  });

  test("US-005 AC5: mkdir's non-flag argument is a write target, flags are not", () => {
    expect(detectTmpWrite("mkdir -p /tmp/probe")).toBe(true);
  });

  test("US-005 AC6: reading from /tmp is not a write", () => {
    expect(detectTmpWrite("cat /tmp/a.txt")).toBe(false);
  });

  test("US-005 AC7: nax's own /tmp/nax-* run directory is not counted", () => {
    expect(detectTmpWrite("echo x > /tmp/nax-r1/US-001-implementer/a.txt")).toBe(false);
  });

  test("US-005 AC8: a relative target resolved against a /tmp cwd is a write", () => {
    expect(detectTmpWrite("echo x > out.txt", "/tmp")).toBe(true);
  });

  test("US-005 AC9: the same relative target from a repo cwd is not a write", () => {
    expect(detectTmpWrite("echo x > out.txt", "/repo")).toBe(false);
  });

  test("US-005 AC10: an opaque (expansion-bearing) target is skipped", () => {
    expect(detectTmpWrite('echo x > "$TMPDIR/a"')).toBe(false);
  });

  test("US-005 AC13: a refused lex scans the lexable prefix without throwing", () => {
    // `2>&1` is refused mid-word; `> /tmp/a.txt` completed before it.
    expect(detectTmpWrite("ls && echo x > /tmp/a.txt 2>&1")).toBe(true);
  });

  test("US-005 AC13: a refused lex with an empty prefix returns false", () => {
    expect(detectTmpWrite("(cat /etc/passwd)")).toBe(false);
  });

  test("US-005 AC2: a relative here-document target with no cwd is not a write", () => {
    const command = "cd repo && cat > tsconfig.json <<'EOF'\n{}\nEOF";
    expect(detectTmpWrite(command)).toBe(false);
  });
});
