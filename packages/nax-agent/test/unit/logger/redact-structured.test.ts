import { describe, expect, test } from "bun:test";
import { redactEntry, redactSecrets } from "#src/internal/redact";

const mask = (text: string): string => redactSecrets(text);

describe("redactSecrets: JSON-shaped text", () => {
  test.each([
    ['{"apiKey": "plainvalue123"}', '{"apiKey": "[REDACTED]"}'],
    ['{"apiKey":"plainvalue123"}', '{"apiKey":"[REDACTED]"}'],
    ['{ "client_secret" :\n\t "plainvalue123" }', '{ "client_secret" :\n\t "[REDACTED]" }'],
    ['{"password":"x"}', '{"password":"[REDACTED]"}'],
    ['{"Authorization": "Bearer abc"}', '{"Authorization": "[REDACTED]"}'],
    ['{"a":{"b":[{"dbPassword":"hunter2"}]}}', '{"a":{"b":[{"dbPassword":"[REDACTED]"}]}}'],
    ['{"token": "t0k3n", "name": "svc"}', '{"token": "[REDACTED]", "name": "svc"}'],
  ])("masks the value, keeps key and structure: %s", (input, expected) => {
    expect(mask(input)).toBe(expected);
  });

  test("masks a value containing escaped quotes without leaking the tail", () => {
    const out = mask('{"password": "ab\\"cdLEAK"}');
    expect(out).not.toContain("LEAK");
    expect(out).toBe('{"password": "[REDACTED]"}');
  });

  test("masks JSON escaped inside a JSON string", () => {
    const inner = '{"apiKey": "plainvalue123", "name": "svc"}';
    const encoded = JSON.stringify(inner);
    const out = mask(encoded);
    expect(out).not.toContain("plainvalue123");
    expect(out).toContain("svc");
    expect(JSON.parse(out)).toBe('{"apiKey": "[REDACTED]", "name": "svc"}');
  });

  test("masks doubly encoded JSON", () => {
    const out = mask(JSON.stringify(JSON.stringify({ password: "plainvalue123" })));
    expect(out).not.toContain("plainvalue123");
  });

  test("masks through the object walk for a string leaf", () => {
    const out = redactSecrets({ output: '{"client_secret": "plainvalue123"}' });
    expect(out.output).toBe('{"client_secret": "[REDACTED]"}');
  });
});

describe("redactSecrets: single-quoted keys", () => {
  test.each([
    ["{'apiKey': 'v1'}", "{'apiKey': '[REDACTED]'}"],
    ["{'password': 'v1'}", "{'password': '[REDACTED]'}"],
    ["{'password':'v1', 'user': 'bob'}", "{'password':'[REDACTED]', 'user': 'bob'}"],
    ["{'token': \"it's\"}", "{'token': \"[REDACTED]\"}"],
  ])("masks %s", (input, expected) => {
    expect(mask(input)).toBe(expected);
  });
});

describe("redactSecrets: long values", () => {
  test("an unquoted value past 4096 characters leaves no tail", () => {
    const out = mask(`API_KEY=${"a".repeat(5000)}ZZTAIL`);
    expect(out).toBe("API_KEY=[REDACTED]");
  });
  test("a double-quoted value past 4096 characters leaves no tail", () => {
    const out = mask(`password="${"a".repeat(5000)}ZZTAIL"`);
    expect(out).toBe('password="[REDACTED]"');
  });
  test("a single-quoted and a JSON value past 4096 characters leave no tail", () => {
    expect(mask(`SECRET='${"a".repeat(5000)}ZZTAIL'`)).toBe("SECRET='[REDACTED]'");
    expect(mask(`{"password": "${"a".repeat(5000)}ZZTAIL"}`)).toBe('{"password": "[REDACTED]"}');
  });
});

describe("redactSecrets: env- and YAML-shaped text", () => {
  test.each([
    ["API_TOKEN=abc", "API_TOKEN=[REDACTED]"],
    ['export OPENAI_API_KEY="abc"', 'export OPENAI_API_KEY="[REDACTED]"'],
    ["SECRET_KEY='abc'", "SECRET_KEY='[REDACTED]'"],
    ["db_password: hunter2", "db_password: [REDACTED]"],
    ['secret_key: "hunter two"', 'secret_key: "[REDACTED]"'],
    ["x-api-key: abc123", "x-api-key: [REDACTED]"],
    ["Authorization: Bearer abc123def456ghi789", "Authorization: [REDACTED]"],
    ["Authorization: Basic abc", "Authorization: [REDACTED]"],
    ['password = "hunter2"', 'password = "[REDACTED]"'],
    ["api_key = abc123xyz", "api_key = [REDACTED]"],
    ["apikey : abc123xyz", "apikey : [REDACTED]"],
    ["X-API-KEY : abc", "X-API-KEY : [REDACTED]"],
    ["API_KEY =abc", "API_KEY =[REDACTED]"],
    ["password = hunter2", "password = [REDACTED]"],
    ["aws_secret_access_key = wJalrXUtnFEMI", "aws_secret_access_key = [REDACTED]"],
    ["Authorization : Bearer x", "Authorization : [REDACTED]"],
  ])("masks the value, keeps the key: %s", (input, expected) => {
    expect(mask(input)).toBe(expected);
  });

  test("masks every line of a dotenv file and keeps the other lines", () => {
    const env = "NODE_ENV=production\nAPI_TOKEN=abc\nPATH=/usr/bin\nSTRIPE_SECRET='sk_live_x'\n";
    expect(mask(env)).toBe("NODE_ENV=production\nAPI_TOKEN=[REDACTED]\nPATH=/usr/bin\nSTRIPE_SECRET='[REDACTED]'\n");
  });

  test("masks a value containing an escaped quote without leaking the tail", () => {
    expect(mask('PASSWORD="ab\\"cdLEAK"')).toBe('PASSWORD="[REDACTED]"');
  });

  test("well-known token shapes are masked regardless of key", () => {
    const text = [
      "note sk-abcdefghijklmnopqrstuv",
      "ghp_abcdefghijklmnopqrst",
      "xoxb-1234567890-abcdef",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJl",
    ].join(" ");
    const out = mask(text);
    for (const leaked of ["sk-abcdef", "ghp_abcdef", "xoxb-1234", "eyJhbGci"]) expect(out).not.toContain(leaked);
  });
});

describe("redactSecrets: values that are not secrets", () => {
  test.each([
    '{"tokens": 1234}',
    '{"inputTokens": 500, "outputTokens": 20}',
    '{"max_tokens": 4096}',
    '{"keyboard": "x"}',
    '{"author": "bob", "sessionId": "s-1", "sessionName": "feat"}',
    '{"password": 123456}',
    "max_tokens=4096",
    "inputTokens: 500",
    "total_tokens: 99",
    "token_count=5",
    "PATH=/usr/bin",
    "keyboard=us",
    "author: bob",
    "sessionName=my-session storyId: story-1",
    "const token = await getToken()",
    "token = process.env.X",
    "secret = loadSecret(name)",
    "avatar_url: https://x/y.png",
    "BASE_URL=http://localhost:3000",
    '{"html_url": "https://github.com/a/b"}',
    "API_TOKEN=$API_TOKEN",
    "API_TOKEN=$\u007BAPI_TOKEN}",
    "const apiKey = process.env.OPENAI_API_KEY",
    "apiKey: string",
    "password: boolean;",
    "Basic authentication failed",
    "the token is stored elsewhere",
  ])("leaves %p unchanged", (text) => {
    expect(mask(text)).toBe(text);
  });

  test("redactEntry leaves run-log correlation fields alone", () => {
    const out = redactEntry({
      message: "sessionName=nax-feat-us-001 storyId=US-001 author=bob",
      data: { sessionName: "nax-feat-us-001", note: "sessionId: abc max_tokens=10" },
    });
    expect(out.message).toBe("sessionName=nax-feat-us-001 storyId=US-001 author=bob");
    expect(out.data?.note).toBe("sessionId: abc max_tokens=10");
  });

  test("credentials inside a connection URL are still masked by the userinfo pattern", () => {
    const out = mask("DATABASE_URL=postgres://u:p@h/db");
    expect(out).not.toContain(":p@");
    expect(out).toContain("[REDACTED]");
  });

  test("is idempotent", () => {
    const once = mask('API_TOKEN=abc {"apiKey": "x"}');
    expect(mask(once)).toBe(once);
  });
});

describe("redactSecrets: bounded cost", () => {
  const MB = 1024 * 1024;
  const adversarial: readonly [string, string][] = [
    ["plain text", "lorem ipsum dolor sit amet ".repeat(Math.ceil(MB / 27))],
    ["one long identifier", "a".repeat(MB)],
    ["quotes", '"'.repeat(MB)],
    ["repeated keys without values", 'secret"'.repeat(MB / 7)],
    ["unterminated secret strings", '{"password": "x'.repeat(MB / 15)],
    ["one huge unterminated value", `{"secret": "${"a".repeat(MB)}`],
    ["separators and whitespace", `token${" ".repeat(MB)}=`],
    ["escape runs", `\\"secret\\"${"\\".repeat(MB)}`],
    ["key-shaped runs", "API_TOKEN_".repeat(MB / 10)],
  ];

  test.each(adversarial)("a 1 MB input completes quickly: %s", (_name, input) => {
    const start = performance.now();
    mask(input);
    expect(performance.now() - start).toBeLessThan(2000);
  });
});
