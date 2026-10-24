import { describe, expect, test } from "bun:test";
import {
  ASK_NO_CHANNEL_REASON,
  ASK_PROFILE_REASON,
  ASK_UNSHOWABLE_REASON,
  type AskRequest,
} from "#src/permissions/index";
import { askDenyReason, askSummary, MAX_ASK_SUMMARY_CHARS, unsandboxedReasonSuffix } from "#src/tools/ask-request";
import type { CodingTool, PolicyVerdict } from "#src/tools/index";
import { resolveAskOutcome } from "#src/tools/runtime-calltool";

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

describe("unsandboxedReasonSuffix", () => {
  /** The AC's literal prefix, pinned verbatim rather than read from the source under test. */
  const PREFIX = " -- runs OUTSIDE the sandbox: ";

  test("AC-1: a plain reason is rendered after the prefix", () => {
    expect(unsandboxedReasonSuffix({ unsandboxedReason: "needs network" })).toBe(`${PREFIX}needs network`);
  });

  test("AC-2: a non-string reason and an absent reason both fall back to no reason given", () => {
    expect(unsandboxedReasonSuffix({ unsandboxedReason: 42 })).toBe(`${PREFIX}no reason given`);
    expect(unsandboxedReasonSuffix({})).toBe(`${PREFIX}no reason given`);
  });

  test("a blank reason renders the fallback, never a dangling clause", () => {
    // A string is "a reason the model gave" only if it says something: the
    // approver must not see ' -- runs OUTSIDE the sandbox: ' with nothing after
    // the colon. Model-authored, so "" and "   " are both reachable (US-006
    // passes the value straight in).
    expect(unsandboxedReasonSuffix({ unsandboxedReason: "" })).toBe(`${PREFIX}no reason given`);
    expect(unsandboxedReasonSuffix({ unsandboxedReason: "   " })).toBe(`${PREFIX}no reason given`);
    expect(unsandboxedReasonSuffix({ unsandboxedReason: "\n\t " })).toBe(`${PREFIX}no reason given`);
  });

  test("AC-3: a 300-character reason is cut to MAX_ASK_SUMMARY_CHARS", () => {
    const suffix = unsandboxedReasonSuffix({ unsandboxedReason: "x".repeat(300) });
    expect(suffix).toBe(`${PREFIX}${"x".repeat(MAX_ASK_SUMMARY_CHARS)}`);
    expect(suffix.slice(PREFIX.length)).toHaveLength(200);
  });

  test("AC-4: a reason maskForPrompt reports unshowable is withheld", () => {
    // The same shell-syntax straddle askSummary withholds: a `Cookie` value
    // containing `;` would hide code from the person approving the command.
    expect(unsandboxedReasonSuffix({ unsandboxedReason: "curl -H 'Cookie: a=b'" })).toBe(`${PREFIX}reason withheld`);
  });

  test("a maskable secret is masked, never rendered", () => {
    const suffix = unsandboxedReasonSuffix({ unsandboxedReason: `needs the token ${GHP}` });
    expect(suffix).not.toContain(GHP);
    expect(suffix).toBe(`${PREFIX}needs the token [REDACTED:github]`);
  });
});

describe("askDenyReason", () => {
  test("unshowable has its own reason", () => {
    expect(askDenyReason("unshowable")).toBe(ASK_UNSHOWABLE_REASON);
    expect(askDenyReason("unavailable")).toBe(ASK_NO_CHANNEL_REASON);
  });

  test("profile has its own reason, not the no-channel fallback", () => {
    expect(askDenyReason("profile")).toBe(ASK_PROFILE_REASON);
    expect(askDenyReason("profile")).not.toBe(ASK_NO_CHANNEL_REASON);
  });
});

type DeniedVerdict = Extract<PolicyVerdict, { readonly allowed: false }>;

const BASH_TOOL: CodingTool = {
  name: "Bash",
  description: "Run a shell command",
  inputSchema: { type: "object", properties: {} },
  scope: { pathFields: [], commandField: "command" },
  run: async () => ({ content: "ran" }),
};

/**
 * Runs `resolveAskOutcome` once, with a resolver that denies, and returns the
 * AskRequest it handed the resolver. Driving the real function rather than
 * restating it is what pins the request's exact key set.
 */
async function askRequestFor(verdict: DeniedVerdict, unsandboxed?: { readonly suffix: string }): Promise<AskRequest> {
  const asked: AskRequest[] = [];
  await resolveAskOutcome({
    identity: "Bash",
    tool: BASH_TOOL,
    input: { command: "curl https://example.com" },
    context: undefined,
    verdict,
    runtimeSignal: undefined,
    askResolver: {
      resolve: (req) => {
        asked.push(req);
        return Promise.resolve({ decision: "deny", decidedBy: "human", latencyMs: 0 });
      },
    },
    stage: "session",
    storyId: undefined,
    root: "/tmp/ask-root",
    logCall: () => {},
    runTool: async () => ({ kind: "ok", content: "ran" }),
    ...(unsandboxed !== undefined ? { unsandboxed } : {}),
  });
  const request = asked[0];
  if (request === undefined) throw new Error("resolveAskOutcome did not ask the resolver");
  return request;
}

describe("resolveAskOutcome — unsandboxed metadata (US-004)", () => {
  const askRule: DeniedVerdict = {
    allowed: false,
    outcome: "ask",
    breach: false,
    rule: "Bash(*)",
    reason: "matches an ask rule",
    resolvedPaths: [],
  };
  /** US-006's converted allow: a synthetic rule, never a configured ask rule. */
  const converted: DeniedVerdict = {
    allowed: false,
    outcome: "ask",
    breach: false,
    rule: "Unsandboxed(Bash)",
    reason: "unsandboxed run requested",
    resolvedPaths: [],
  };

  test("AC-5: a real ask rule keeps matchedRule and appends the suffix", async () => {
    const request = await askRequestFor(askRule, { suffix: " -- S" });
    expect(request).toMatchObject({
      rule: "Bash(*)",
      matchedRule: "Bash(*)",
      unsandboxed: true,
      reason: "matches an ask rule -- S",
    });
  });

  test("AC-6: a synthetic Unsandboxed rule sets the flag, keeps rule, leaves matchedRule unset", async () => {
    const request = await askRequestFor(converted, { suffix: " -- S" });
    expect(request.rule).toBe("Unsandboxed(Bash)");
    expect(request.reason).toBe("unsandboxed run requested -- S");
    expect(request).toHaveProperty("unsandboxed", true);
    expect("matchedRule" in request).toBe(false);
  });

  test("AC-7: without the unsandboxed argument nothing is added", async () => {
    const request = await askRequestFor(askRule);
    expect(request.reason).toBe("matches an ask rule");
    expect("unsandboxed" in request).toBe(false);
  });
});
