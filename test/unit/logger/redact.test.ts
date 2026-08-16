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

  // MED-01: SECRET_VALUE_PATTERNS covered only sk-/ghp_/npm_/AKIA/xox* — PEM
  // blocks, JWTs, and Authorization headers in free text passed through.
  describe("MED-01 secret-shaped free-text patterns", () => {
    test("redacts a PEM private key block", () => {
      const pem = [
        "-----BEGIN RSA PRIVATE KEY-----",
        "MIIEpAIBAAKCAQEA1c7+9z5Pad7OejecsQ0bu3aumnAxuNbaBcEAFy6mBAMzKZzk",
        "-----END RSA PRIVATE KEY-----",
      ].join("\n");
      const out = redactSecrets({ output: `key:\n${pem}\ndone` }) as any;
      expect(out.output).not.toContain("MIIEpAIBAAKCAQEA1c7");
      expect(out.output).toContain("[REDACTED]");
      expect(out.output).toContain("done");
    });

    test("redacts a JWT", () => {
      const jwt =
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
      const out = redactSecrets({ output: `auth: ${jwt}` }) as any;
      expect(out.output).not.toContain(jwt);
      expect(out.output).toContain("[REDACTED]");
    });

    test("redacts a Bearer authorization header value", () => {
      const out = redactSecrets({ output: "Authorization: Bearer abc123def456ghi789" }) as any;
      expect(out.output).not.toContain("abc123def456ghi789");
      expect(out.output).toContain("[REDACTED]");
    });

    test("redacts a Basic authorization header value", () => {
      const out = redactSecrets({ output: "Authorization: Basic dXNlcjpwYXNzd29yZA==" }) as any;
      expect(out.output).not.toContain("dXNlcjpwYXNzd29yZA==");
      expect(out.output).toContain("[REDACTED]");
    });

    // Security-review follow-up: raising the length floor to 16 (an earlier
    // revision of the over-redaction fix) would have under-redacted a short
    // but real base64 basic-auth credential. The floor stays at 8 — only
    // the "must look credential-shaped" requirement excludes prose.
    test("still redacts a short (8-15 char) credential-shaped Basic value", () => {
      const out = redactSecrets({ output: "Authorization: Basic Ym9iOjl4Mg==" }) as any; // base64("bob:9x2"), 12 chars
      expect(out.output).not.toContain("Ym9iOjl4Mg==");
      expect(out.output).toContain("[REDACTED]");
    });

    // LOG-1 regression: splitting the combined Bearer|Basic pattern into two
    // (to keep the mixed-case payload heuristic case-sensitive) must not
    // lose case-insensitivity on the "Basic" scheme keyword itself — the
    // scheme name is case-insensitive per RFC 7617.
    test("redacts a Basic authorization header regardless of scheme-name casing", () => {
      const lower = redactSecrets({ output: "Authorization: basic dXNlcjpwYXNzd29yZA==" }) as any;
      expect(lower.output).not.toContain("dXNlcjpwYXNzd29yZA==");
      expect(lower.output).toContain("[REDACTED]");

      const upper = redactSecrets({ output: "Authorization: BASIC dXNlcjpwYXNzd29yZA==" }) as any;
      expect(upper.output).not.toContain("dXNlcjpwYXNzd29yZA==");
      expect(upper.output).toContain("[REDACTED]");
    });

    // LOG-1: gh[opsu]_ never matches "github_pat_" ("gh" + "i" is not one of [opsu]).
    test("redacts a GitHub fine-grained PAT (github_pat_...)", () => {
      const token = `github_pat_${"A".repeat(22)}_${"B".repeat(59)}`;
      const out = redactSecrets({ output: `token: ${token}` }) as any;
      expect(out.output).not.toContain(token);
      expect(out.output).toContain("[REDACTED]");
    });

    // LOG-1: Telegram bot tokens ("<bot-id>:<secret>") had no dedicated pattern.
    test("redacts a Telegram bot token", () => {
      const token = "123456789:AAHfj93kdLp2mZ8xQvN4rT6yU1wX0sB7cD-EfG";
      const out = redactSecrets({ output: `bot token: ${token}` }) as any;
      expect(out.output).not.toContain(token);
      expect(out.output).toContain("[REDACTED]");
    });

    test("redacts an x-api-key header captured in free text", () => {
      const out = redactSecrets({ output: "x-api-key: abcd1234efgh5678" }) as any;
      expect(out.output).not.toContain("abcd1234efgh5678");
      expect(out.output).toContain("[REDACTED]");
    });

    // Security-review follow-up: an earlier revision bounded the BEGIN/END
    // gap to 8KB, which would silently miss a legitimate multi-cert chain
    // bundle exceeding that size. The bound is now 64KB.
    test("redacts a PEM block larger than 8KB (bundled certificate chain)", () => {
      const bigBody = "A".repeat(20_000); // well past the old 8KB bound, within the new 64KB one
      const pem = `-----BEGIN CERTIFICATE-----\n${bigBody}\n-----END CERTIFICATE-----`;
      const out = redactSecrets({ output: `chain:\n${pem}\ndone` }) as any;
      expect(out.output).not.toContain(bigBody);
      expect(out.output).toContain("[REDACTED]");
      expect(out.output).toContain("done");
    });

    test("redacts a PGP-style PEM block (' ... BLOCK' suffix)", () => {
      const pem = [
        "-----BEGIN PGP PRIVATE KEY BLOCK-----",
        "lQOYBFtestKeyMaterialHerexxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
        "-----END PGP PRIVATE KEY BLOCK-----",
      ].join("\n");
      const out = redactSecrets({ output: `key:\n${pem}\ndone` }) as any;
      expect(out.output).not.toContain("lQOYBFtestKeyMaterialHere");
      expect(out.output).toContain("[REDACTED]");
    });

    // Regression: the original Bearer/Basic pattern matched any 8+ char
    // word-token after the literal word, swallowing ordinary log prose
    // that just happens to use those English words.
    test("does NOT redact ordinary prose containing the words Bearer/Basic", () => {
      const out1 = redactSecrets({ output: "Basic authentication failed for user" }) as any;
      expect(out1.output).toBe("Basic authentication failed for user");

      const out2 = redactSecrets({ output: "use Bearer authentication scheme" }) as any;
      expect(out2.output).toBe("use Bearer authentication scheme");
    });

    // The PEM pattern's BEGIN/END gap is bounded (not [\s\S]*?) so an
    // unterminated "BEGIN" marker in a large payload (real agent
    // stdout/stderr) can't force a full end-of-string re-scan per
    // occurrence. Functional check: content just past the bound is left
    // untouched rather than folded into a redaction that never finds an END.
    test("does not redact past the bounded gap when no END marker follows", () => {
      const beyondBound = "-".repeat(9000);
      const out = redactSecrets({ output: `-----BEGIN RSA PRIVATE KEY-----${beyondBound}tail-marker` }) as any;
      expect(out.output).toContain("tail-marker");
    });
  });

  // SEC-1 (Round 2 review): DATABASE_URL / *DSN / *URI / *_URL object keys
  // were not in SECRET_KEY_PATTERN, so values like `postgres://admin:secret@db/prod`
  // passed through both redaction layers. The KEY=value pattern required
  // SECRET|TOKEN|... before `=`, which DATABASE_URL doesn't satisfy.
  describe("SEC-1 URL userinfo credentials", () => {
    test.each([
      ["DATABASE_URL", "postgres://admin:s3cret@db.internal:5432/prod"],
      ["REDIS_URL", "redis://:hunter2@cache.internal:6379/0"],
      ["MONGO_URI", "mongodb://root:mongoPwd@mongo.internal:27017/admin"],
      ["POSTGRES_DSN", "postgresql://user:p%40ss@host/db"],
      ["SMTP_URL", "smtps://user:smtpPass@mail.internal:465"],
      ["CONNECTIONSTRING", "Server=tcp:db,1433;User Id=sa;Password=Sql!Pass;"],
    ])("redacts value of key %s", (key, value) => {
      const out = redactSecrets({ [key]: value }) as Record<string, unknown>;
      expect(out[key]).toBe("[REDACTED]");
      // The JSON serialization of the redacted payload must NOT contain the
      // raw value (the value is replaced wholesale with "[REDACTED]").
      expect(JSON.stringify(out)).not.toContain(value);
    });

    test("redacts scheme://user:pass@host shape embedded in free text", () => {
      const url = "postgres://admin:s3cret@db.internal:5432/prod";
      const out = redactSecrets({ command: `DATABASE_URL=${url} npm run lint` }) as any;
      expect(out.command).toContain("[REDACTED]");
      expect(out.command).not.toContain("s3cret");
    });

    test("redacts scheme://user:pass@host in a `message` field", () => {
      const url = "redis://:hunter2@cache.internal:6379/0";
      const out = redactSecrets({ message: `connecting to ${url}` }) as any;
      expect(out.message).not.toContain("hunter2");
      expect(out.message).toContain("[REDACTED]");
    });

    // Sanity: a URL without credentials must NOT be redacted.
    test("does NOT redact a credential-less URL (no false positives)", () => {
      const out = redactSecrets({ homepage: "https://example.com/foo" }) as any;
      expect(out.homepage).toBe("https://example.com/foo");
    });
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
