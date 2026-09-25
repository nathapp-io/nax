import { describe, expect, test } from "bun:test";
import { ASK_NO_CHANNEL_REASON, ASK_UNSHOWABLE_REASON } from "@/permissions";
import { askDenyReason, askSummary, MAX_ASK_SUMMARY_CHARS } from "@/tools/ask-request";

const GHP = "ghp_abcdefghijklmnop1234";

describe("askSummary", () => {
  test("a plain command is unchanged", () => {
    expect(askSummary("Bash", { pathFields: [], commandField: "command" }, { command: "bun run test" })).toEqual({
      summary: "Bash command=bun run test",
      unshowable: false,
    });
  });

  test("a secret whose cut-first prefix matches no pattern is masked BEFORE the cut", () => {
    // The discriminating straddle: the 200-char window ends 20 chars into the
    // JWT's first segment, so cut-first leaves `eyJhbGciOiJIUzI1NiIs` — a
    // fragment no SECRET_VALUE_PATTERNS regex matches alone — and the partial
    // secret goes out. (Replaces the earlier ghp_ straddle, whose cut-first
    // leak was a bare `g` that matched no assertion and could never fail.)
    const b64url = (s: string): string => Buffer.from(s, "utf8").toString("base64url");
    const jwt = [
      b64url('{"alg":"HS256","typ":"JWT"}'),
      b64url('{"sub":"user-12345"}'),
      b64url("deterministic-signature"),
    ].join(".");
    const command = `${"x".repeat(166)} ${jwt}`;
    const s = askSummary("Bash", { pathFields: [], commandField: "command" }, { command });
    expect(s.unshowable).toBe(false);
    expect(s.summary.length).toBeLessThanOrEqual(MAX_ASK_SUMMARY_CHARS);
    expect(s.summary).toContain("[REDACTED:jwt]");
    expect(s.summary).not.toContain("eyJ");
  });

  test("Review Focus 2: a secret in an Exec argv is masked", () => {
    const s = askSummary("Exec", { pathFields: [], argvField: "argv" }, { argv: ["gh", "auth", GHP] });
    expect(s.summary).toContain("[REDACTED:github]");
    expect(s.summary).not.toContain(GHP);
  });

  test("Review Focus 3: a secret in a Write path field is masked", () => {
    const s = askSummary("Write", { pathFields: ["path"] }, { path: `notes/${GHP}.txt` });
    expect(s.summary).not.toContain(GHP);
  });

  test("a secret spanning shell syntax withholds the arguments", () => {
    const s = askSummary("Bash", { pathFields: [], commandField: "command" }, { command: "curl -H 'Cookie: a=b'" });
    expect(s).toEqual({ summary: "Bash [arguments withheld: contains a secret]", unshowable: true });
  });
});

describe("askDenyReason", () => {
  test("unshowable has its own reason", () => {
    expect(askDenyReason("unshowable")).toBe(ASK_UNSHOWABLE_REASON);
    expect(askDenyReason("unavailable")).toBe(ASK_NO_CHANNEL_REASON);
  });
});
