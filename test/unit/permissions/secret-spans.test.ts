import { describe, expect, test } from "bun:test";
import { findSecretSpans, maskForPrompt, redactForRow, redactRowStrings } from "@/permissions";

const SK = "sk-abcdefghijklmnop1234";
const GHP = "ghp_abcdefghijklmnop1234";

describe("maskForPrompt", () => {
  test("masks an inert Bearer token with its kind", () => {
    const r = maskForPrompt("curl -H Authorization:Bearer abc123def456 https://x");
    expect(r).toEqual({ ok: true, masked: "curl -H Authorization:[REDACTED:bearer] https://x", count: 1 });
  });

  test("masks sk- and ghp_ values", () => {
    const r = maskForPrompt(`OPENAI=${SK} gh auth ${GHP}`);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.masked).not.toContain(SK);
    expect(r.masked).not.toContain(GHP);
    expect(r.masked).toContain("[REDACTED:github]");
    expect(r.count).toBe(2);
  });

  test("overlapping patterns merge into one span (TOKEN=ghp_...)", () => {
    expect(findSecretSpans(`TOKEN=${GHP}`)).toHaveLength(1);
  });

  test("a value that references a variable is not a secret", () => {
    expect(findSecretSpans("GH_TOKEN=$(gh auth token) gh pr list")).toHaveLength(0);
    expect(findSecretSpans(`TOKEN=\${X} run`)).toHaveLength(0);
  });

  test("a span containing shell syntax is not showable", () => {
    expect(maskForPrompt("curl -H 'Cookie: a=b'; rm -rf ~").ok).toBe(false);
    expect(maskForPrompt("TOKEN=abc;rm x").ok).toBe(false);
    const pem = "echo '-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----'";
    expect(maskForPrompt(pem).ok).toBe(false);
  });

  test("text with no secret is returned unchanged", () => {
    expect(maskForPrompt("bun run test 2>&1 | tail -n 40")).toEqual({
      ok: true,
      masked: "bun run test 2>&1 | tail -n 40",
      count: 0,
    });
  });

  test("repeated calls give identical results (no shared lastIndex state)", () => {
    const text = `a ${SK} b ${SK}`;
    expect(maskForPrompt(text)).toEqual(maskForPrompt(text));
    expect(findSecretSpans(text)).toHaveLength(2);
  });
});

describe("redactForRow", () => {
  test("keeps the shell syntax after a secret visible", () => {
    const out = redactForRow("curl -H 'Cookie: a=b'; rm -rf ~");
    expect(out).toContain("'; rm -rf ~");
    expect(out).not.toContain("a=b");
  });

  test("a PEM block is redacted whole", () => {
    const out = redactForRow("-----BEGIN PRIVATE KEY-----\nMIIBSECRET\n-----END PRIVATE KEY-----");
    expect(out).not.toContain("MIIBSECRET");
  });
});

describe("redactRowStrings", () => {
  test("walks nested objects and arrays, keeping keys and non-strings", () => {
    const row = { request: { command: `echo ${SK}`, argv: ["x", GHP] }, latencyMs: 3, api_key: "plain" };
    const out = redactRowStrings(row);
    expect(out.request.command).not.toContain(SK);
    expect(out.request.argv[1]).not.toContain(GHP);
    expect(out.latencyMs).toBe(3);
    expect(out.api_key).toBe("plain");
  });
});
