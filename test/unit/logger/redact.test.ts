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
});
