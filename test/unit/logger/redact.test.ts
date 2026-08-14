import { describe, expect, test } from "bun:test";
import { redactSecrets } from "../../../src/logger/redact";

describe("redactSecrets", () => {
  test("masks values of known secret keys", () => {
    const out = redactSecrets({ AWS_SECRET_ACCESS_KEY: "AKIAabc123", note: "ok" }) as any;
    expect(out.AWS_SECRET_ACCESS_KEY).toBe("[REDACTED]");
    expect(out.note).toBe("ok");
  });

  test("masks token-shaped substrings in free text", () => {
    const out = redactSecrets({
      output: "using sk-ant-aaaaaaaaaaaaaaaaaaaa and ghp_bbbbbbbbbbbbbbbbbbbb",
    }) as any;
    expect(out.output).not.toContain("sk-ant-aaaaaaaaaaaaaaaaaaaa");
    expect(out.output).not.toContain("ghp_bbbbbbbbbbbbbbbbbbbb");
    expect(out.output).toContain("[REDACTED]");
  });

  test("recurses nested objects", () => {
    const out = redactSecrets({ a: { GITHUB_TOKEN: "ghp_xxxxxxxxxxxxxxxxxxxx" } }) as any;
    expect(JSON.stringify(out)).not.toContain("ghp_xxxxxxxxxxxxxxxxxxxx");
  });

  test("recurses arrays", () => {
    const out = redactSecrets({ list: ["NPM_TOKEN=npm_yyyy"] }) as any;
    expect(JSON.stringify(out)).not.toContain("npm_yyyy");
  });

  test("leaves non-secret values unchanged", () => {
    const out = redactSecrets({ message: "hello world", count: 42 }) as any;
    expect(out.message).toBe("hello world");
    expect(out.count).toBe(42);
  });

  test("does not redact plural metric keys: tokens, inputTokens, totalTokens", () => {
    const out = redactSecrets({ tokens: 1234, inputTokens: 500, totalTokens: 1000 }) as any;
    expect(out.tokens).toBe(1234);
    expect(out.inputTokens).toBe(500);
    expect(out.totalTokens).toBe(1000);
  });

  test("still redacts singular token credential keys: token, GITHUB_TOKEN, accessToken", () => {
    const out = redactSecrets({ token: "abc123", GITHUB_TOKEN: "ghp_xxxx", accessToken: "bearer_xyz" }) as any;
    expect(out.token).toBe("[REDACTED]");
    expect(out.GITHUB_TOKEN).toBe("[REDACTED]");
    expect(out.accessToken).toBe("[REDACTED]");
  });

  // MED-02: unguarded recursion threw RangeError (stack overflow) out of
  // every logger call whenever a data payload contained a circular reference.
  describe("circular references (MED-02)", () => {
    test("a self-referencing object does not throw and marks the cycle", () => {
      const obj: Record<string, unknown> = { name: "story" };
      obj.self = obj;

      expect(() => redactSecrets(obj)).not.toThrow();
      const out = redactSecrets(obj) as any;
      expect(out.name).toBe("story");
      expect(out.self).toBe("[Circular]");
    });

    test("a self-referencing array does not throw", () => {
      const arr: unknown[] = [1, 2];
      arr.push(arr);

      expect(() => redactSecrets(arr)).not.toThrow();
      const out = redactSecrets(arr) as any[];
      expect(out[0]).toBe(1);
      expect(out[2]).toBe("[Circular]");
    });

    test("a mutual reference between two objects does not throw", () => {
      const a: Record<string, unknown> = { id: "a" };
      const b: Record<string, unknown> = { id: "b", a };
      a.b = b;

      expect(() => redactSecrets(a)).not.toThrow();
    });

    test("the same object appearing twice at non-nested (sibling) positions is not treated as circular", () => {
      const shared = { value: "shared" };
      const out = redactSecrets({ first: shared, second: shared }) as any;

      expect(out.first).toEqual({ value: "shared" });
      expect(out.second).toEqual({ value: "shared" });
    });

    test("a very deep (but acyclic) object is bounded, not stack-overflowed", () => {
      let deep: Record<string, unknown> = { leaf: true };
      for (let i = 0; i < 500; i++) {
        deep = { nested: deep };
      }

      expect(() => redactSecrets(deep)).not.toThrow();
    });
  });
});
