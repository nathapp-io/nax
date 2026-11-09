import { describe, expect, test } from "bun:test";
import type { ApprovalMemoryDecision, ApprovalMemoryRequest } from "#src/index";
import * as agent from "#src/index";

describe("approvalMemoryKey", () => {
  test("AC-1: is exported as a function from the public entry", () => {
    expect(typeof agent.approvalMemoryKey).toBe("function");
  });

  test.each<[string, ApprovalMemoryRequest, string | undefined]>([
    ["AC-2: non-execute tool", { tool: "Edit" }, "Edit"],
    ["AC-3: leading whitespace and subcommand", { tool: "Bash", command: "  git push origin main" }, "Bash:git push"],
    ["AC-4: key ignores later flags", { tool: "Bash", command: "npm test -- --watch" }, "Bash:npm test"],
    ["AC-5: bare command", { tool: "Bash", command: "ls" }, "Bash:ls"],
    ["AC-6: script path", { tool: "Bash", command: "./scripts/build.sh" }, "Bash:./scripts/build.sh"],
    ["AC-7: flag second word", { tool: "Bash", command: "rm -f x" }, undefined],
    ["AC-8: bash wrapper", { tool: "Bash", command: "bash -c ls" }, undefined],
    ["AC-8: sudo wrapper", { tool: "Bash", command: "sudo make install" }, undefined],
    ["AC-8: wrapper basename", { tool: "Bash", command: "/usr/bin/env ls" }, undefined],
    ["AC-9: environment assignment", { tool: "Bash", command: "FOO=1 npm test" }, undefined],
    ["AC-10: quoted second word", { tool: "Bash", command: "git 'status'" }, undefined],
    ["AC-11: glob", { tool: "Bash", command: "ls *.ts" }, undefined],
    ["AC-12: expansion", { tool: "Bash", command: "git $CMD" }, undefined],
    ["AC-13: masked command", { tool: "Bash", command: "echo [REDACTED:token]" }, undefined],
    ["AC-14: no command", { tool: "Bash" }, undefined],
    ["AC-15: RunCommand", { tool: "RunCommand", command: "npm test" }, "RunCommand:npm test"],
    // New AC-1 to AC-10: Package managers with exec/x/dlx/create/init
    ["AC-1: npm exec prettier", { tool: "Bash", command: "npm exec prettier" }, undefined],
    ["AC-2: npm x prettier", { tool: "Bash", command: "npm x prettier" }, undefined],
    ["AC-3: pnpm dlx create-app", { tool: "Bash", command: "pnpm dlx create-app" }, undefined],
    ["AC-4: pnpm exec tsc", { tool: "Bash", command: "pnpm exec tsc" }, undefined],
    ["AC-5: yarn dlx create-app", { tool: "Bash", command: "yarn dlx create-app" }, undefined],
    ["AC-6: yarn exec tsc", { tool: "Bash", command: "yarn exec tsc" }, undefined],
    ["AC-7: npm create vite", { tool: "Bash", command: "npm create vite" }, undefined],
    ["AC-8: pnpm create vite", { tool: "Bash", command: "pnpm create vite" }, undefined],
    ["AC-9: yarn create vite", { tool: "Bash", command: "yarn create vite" }, undefined],
    ["AC-10: npm init vite", { tool: "Bash", command: "npm init vite" }, undefined],
    // AC-11 to AC-16: Package managers with run/install/i/add + third word
    ["AC-11: npm install lodash", { tool: "Bash", command: "npm install lodash" }, "Bash:npm install lodash"],
    ["AC-12: npm install bare", { tool: "Bash", command: "npm install" }, "Bash:npm install"],
    ["AC-13: npm run test", { tool: "Bash", command: "npm run test" }, "Bash:npm run test"],
    ["AC-14: npm run deploy", { tool: "Bash", command: "npm run deploy" }, "Bash:npm run deploy"],
    ["AC-15: pnpm run build", { tool: "Bash", command: "pnpm run build" }, "Bash:pnpm run build"],
    ["AC-16: npm test", { tool: "Bash", command: "npm test" }, "Bash:npm test"],
  ])("%s", (_name, request, expected) => {
    expect(agent.approvalMemoryKey(request)).toBe(expected);
  });

  test.each([
    "git -C repo status",
    "ls -la src",
    'git "status"',
    "git pu*h",
    "git 'push' --force",
    "[REDACTED:github] rm -rf build",
    "curl -H [REDACTED:bearer] https://x",
    "env X=1 rm x",
    "xargs rm",
    "find . -delete",
    "node -e 1",
    "'bash' -c x",
    '"sh" x',
    "b\\ash -c x",
    "ba*h -c x",
    "BASH -c x",
    "/usr/bin/BaSh x",
    "$(which sh) x",
    "./scripts/build.sh --fast",
    "",
    "   ",
    "/usr/bin/",
  ])("refuses unsafe or empty key: %s", (command) => {
    expect(agent.approvalMemoryKey({ tool: "Bash", command })).toBeUndefined();
  });

  test.each(["Git", "GitCommit"])("treats %s as an execute tool", (tool) => {
    expect(agent.approvalMemoryKey({ tool })).toBeUndefined();
    expect(agent.approvalMemoryKey({ tool, command: "git status" })).toBe(`${tool}:git status`);
  });
});

describe("approvalMemoryApplies", () => {
  test.each<[string, ApprovalMemoryRequest, ApprovalMemoryDecision, boolean]>([
    ["AC-16: simple allow", { tool: "Bash", command: "git status" }, "allow", true],
    ["AC-17: compound allow", { tool: "Bash", command: "git status; rm -rf x" }, "allow", false],
    ["AC-18: later flag allow", { tool: "Bash", command: "git push origin --force" }, "allow", false],
    ["AC-19: later flag deny", { tool: "Bash", command: "git push origin --force" }, "deny", true],
    ["AC-20: non-execute allow", { tool: "Edit" }, "allow", true],
  ])("%s", (_name, request, decision, expected) => {
    expect(agent.approvalMemoryApplies(request, decision)).toBe(expected);
  });

  test.each([
    "git status && echo done",
    "git status | less",
    "git status `pwd`",
    "git status $CMD",
    "git status (pwd)",
    "git status < x",
    "git status > x",
    "git status\nwhoami",
    "git status\rwhoami",
    "git status --short",
    "git push origin -f",
    "git status '*.ts'",
    "git status *.ts",
    "git status [REDACTED:token]",
  ])("refuses remembered allow but permits remembered deny: %s", (command) => {
    expect(agent.approvalMemoryApplies({ tool: "Bash", command }, "allow")).toBe(false);
    expect(agent.approvalMemoryApplies({ tool: "Bash", command }, "deny")).toBe(true);
  });

  test.each(["Bash", "RunCommand", "Git", "GitCommit"])("checks later arguments for %s", (tool) => {
    expect(agent.approvalMemoryApplies({ tool, command: "git push origin feature" }, "allow")).toBe(true);
    expect(agent.approvalMemoryApplies({ tool, command: "git push origin --force" }, "allow")).toBe(false);
  });

  test("key eligibility is separate from applying a decision already found under a key", () => {
    const request = { tool: "Bash", command: "npm test -- --watch" };
    expect(agent.approvalMemoryKey(request)).toBe("Bash:npm test");
    expect(agent.approvalMemoryApplies(request, "allow")).toBe(false);
    expect(agent.approvalMemoryApplies({ tool: "Bash" }, "allow")).toBe(true);
    expect(agent.approvalMemoryKey({ tool: "Bash" })).toBeUndefined();
  });

  test("AC-17: npm run test --watch is not approved by a bare npm run test allow", () => {
    expect(agent.approvalMemoryApplies({ tool: "Bash", command: "npm run test --watch" }, "allow")).toBe(false);
  });

  test("F1: npm install lodash evil-pkg generates a distinct key from npm install lodash", () => {
    const key1 = agent.approvalMemoryKey({ tool: "Bash", command: "npm install lodash" });
    const key2 = agent.approvalMemoryKey({ tool: "Bash", command: "npm install lodash evil-pkg" });
    expect(key1).toBe("Bash:npm install lodash");
    expect(key2).toBe("Bash:npm install lodash evil-pkg");
    expect(key1).not.toBe(key2);
  });

  test("F1: npm run test deploy generates a distinct key from npm run test", () => {
    const key1 = agent.approvalMemoryKey({ tool: "Bash", command: "npm run test" });
    const key2 = agent.approvalMemoryKey({ tool: "Bash", command: "npm run test deploy" });
    expect(key1).toBe("Bash:npm run test");
    expect(key2).toBe("Bash:npm run test deploy");
    expect(key1).not.toBe(key2);
  });

  test.each([
    ["run-script", "test", "deploy"],
    ["rum", "test", "deploy"],
    ["urn", "test", "deploy"],
    ["it", "lodash", "evil-pkg"],
    ["install-test", "lodash", "evil-pkg"],
    ["explore", "foo", "bar"],
  ])("npm %s aliases key on the full plain-word argv: %s vs %s", (alias, a, b) => {
    const keyA = agent.approvalMemoryKey({ tool: "Bash", command: `npm ${alias} ${a}` });
    const keyB = agent.approvalMemoryKey({ tool: "Bash", command: `npm ${alias} ${b}` });
    expect(keyA).toBe(`Bash:npm ${alias} ${a}`);
    expect(keyB).toBe(`Bash:npm ${alias} ${b}`);
    expect(keyA).not.toBe(keyB);
  });

  test("npm innit and pnpm create are never remembered", () => {
    expect(agent.approvalMemoryKey({ tool: "Bash", command: "npm innit foo" })).toBeUndefined();
    expect(agent.approvalMemoryKey({ tool: "Bash", command: "pnpm create foo" })).toBeUndefined();
  });

  test("F1: npm install lodash --save filters out flags and only includes plain words", () => {
    const key = agent.approvalMemoryKey({ tool: "Bash", command: "npm install lodash --save" });
    expect(key).toBe("Bash:npm install lodash");
  });
});
