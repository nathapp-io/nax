import { describe, expect, test } from "bun:test";
import { createStderrTail } from "#src/infra/stderr-tail";

describe("createStderrTail", () => {
  test("keeps only the last capacity bytes", () => {
    const tail = createStderrTail(10);
    tail.push("0123456789");
    tail.push("abcde");
    expect(tail.excerpt({ maxBytes: 100 })).toBe("56789abcde");
  });

  test("accepts bytes and strips control characters but keeps newlines and tabs", () => {
    const tail = createStderrTail();
    tail.push(new TextEncoder().encode("a\u0007b\tc\nd\u001b[31m"));
    expect(tail.excerpt()).toBe("ab\tc\nd[31m");
  });

  test("redacts caller secrets and known token shapes", () => {
    const tail = createStderrTail();
    tail.push("token=hunter2-secret-value and ghp_0123456789abcdefghijklmnopqrstuvwxyzAB");
    const out = tail.excerpt({ secrets: ["hunter2-secret-value"] });
    expect(out).not.toContain("hunter2-secret-value");
    expect(out).not.toContain("ghp_0123456789abcdefghijklmnopqrstuvwxyzAB");
  });

  test("excerpt returns the last maxBytes bytes", () => {
    const tail = createStderrTail();
    tail.push("x".repeat(5000) + "END");
    const out = tail.excerpt({ maxBytes: 8 });
    expect(out.endsWith("END")).toBe(true);
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(8);
  });

  test("ignores secrets shorter than 4 characters so they do not shred the text", () => {
    const tail = createStderrTail();
    tail.push("a b c");
    expect(tail.excerpt({ secrets: ["a"] })).toBe("a b c");
  });
});
