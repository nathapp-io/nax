import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  isNaxConfigFile,
  isNaxOwnedWritePath,
  NAX_OWNED_WRITE_TOOLS,
  NAX_SCRATCHPAD_ENTRY,
  naxOwnedKind,
  naxOwnedWriteRefusal,
  naxWriteOptIns,
} from "@/tools/nax-owned-writes";
import { SCRATCHPAD_DIR } from "@/tools/scratchpad";

const ROOT = "/repo";

describe("isNaxConfigFile", () => {
  test("refuses the root config", () => {
    expect(isNaxConfigFile(ROOT, join(ROOT, ".nax", "config.json"))).toBe(true);
  });

  test("refuses a single-segment monorepo override", () => {
    expect(isNaxConfigFile(ROOT, join(ROOT, ".nax", "mono", "api", "config.json"))).toBe(true);
  });

  test("allows an ordinary file under .nax/mono", () => {
    expect(isNaxConfigFile(ROOT, join(ROOT, ".nax", "mono", "api", "notes.md"))).toBe(false);
  });

  test("allows a config.json that is not nax's own", () => {
    expect(isNaxConfigFile(ROOT, join(ROOT, "docs", "nax", "config.json"))).toBe(false);
  });

  test("allows a path outside the root", () => {
    expect(isNaxConfigFile(join(ROOT, "packages", "api"), join(ROOT, ".nax", "config.json"))).toBe(false);
  });

  test("refuses a nested monorepo override — the real shape loader.ts writes", () => {
    expect(isNaxConfigFile(ROOT, join(ROOT, ".nax", "mono", "packages", "api", "config.json"))).toBe(true);
  });

  test("refuses a deeply nested monorepo override", () => {
    expect(isNaxConfigFile(ROOT, join(ROOT, ".nax", "mono", "services", "edge", "api", "config.json"))).toBe(true);
  });

  test("still allows a non-config file at the same nesting", () => {
    expect(isNaxConfigFile(ROOT, join(ROOT, ".nax", "mono", "packages", "api", "notes.md"))).toBe(false);
  });

  test("does not refuse a bare .nax/mono/config.json — no such override exists", () => {
    expect(isNaxConfigFile(ROOT, join(ROOT, ".nax", "mono", "config.json"))).toBe(false);
  });
});

describe("naxOwnedWriteRefusal", () => {
  test("refuses Write to a feature PRD", () => {
    expect(naxOwnedWriteRefusal("Write", ".nax/features/auth/prd.json")).toBeDefined();
  });

  test("refuses Edit, Delete and GitCommit to the same path", () => {
    for (const tool of ["Edit", "Delete", "GitCommit"]) {
      expect(naxOwnedWriteRefusal(tool, ".nax/features/auth/prd.json")).toBeDefined();
    }
  });

  test("allows READS of a feature PRD — an agent legitimately reads its own PRD", () => {
    for (const tool of ["Read", "Grep", "Glob", "Git"]) {
      expect(naxOwnedWriteRefusal(tool, ".nax/features/auth/prd.json")).toBeUndefined();
    }
  });

  test("#2260: refuses other non-test files under .nax/features too", () => {
    expect(naxOwnedWriteRefusal("Write", ".nax/features/auth/notes.md")).toBeDefined();
  });

  test("allows writes to an ordinary prd.json outside .nax", () => {
    expect(naxOwnedWriteRefusal("Write", "docs/prd.json")).toBeUndefined();
  });

  test("the reason names the path and says why", () => {
    const reason = naxOwnedWriteRefusal("Write", ".nax/features/auth/prd.json");
    expect(reason).toContain(".nax/features/auth/prd.json");
    expect(reason).toContain("acceptance criteria");
  });

  test("the mutating set is exactly the path-bearing tools that mutate", () => {
    expect([...NAX_OWNED_WRITE_TOOLS].sort()).toEqual(["Delete", "Edit", "GitCommit", "Write"]);
  });
});

describe("naxOwnedWriteRefusal — queue run-control file (SEC-5)", () => {
  test("refuses Write to .queue.txt", () => {
    expect(naxOwnedWriteRefusal("Write", ".queue.txt")).toBeDefined();
  });

  test("refuses Edit to the atomic-rename target .queue.txt.processing", () => {
    expect(naxOwnedWriteRefusal("Edit", ".queue.txt.processing")).toBeDefined();
  });

  test("refuses the whole mutating set to both queue files", () => {
    for (const tool of ["Write", "Edit", "Delete", "GitCommit"]) {
      expect(naxOwnedWriteRefusal(tool, ".queue.txt")).toBeDefined();
      expect(naxOwnedWriteRefusal(tool, ".queue.txt.processing")).toBeDefined();
    }
  });

  test("allows reads of the queue file — Read/Grep are not refused", () => {
    for (const tool of ["Read", "Grep", "Glob", "Git"]) {
      expect(naxOwnedWriteRefusal(tool, ".queue.txt")).toBeUndefined();
      expect(naxOwnedWriteRefusal(tool, ".queue.txt.processing")).toBeUndefined();
    }
  });

  test("leaves an unrelated .txt at root writable", () => {
    expect(naxOwnedWriteRefusal("Write", "notes.txt")).toBeUndefined();
  });

  test("does not refuse a .queue.txt nested in a subdirectory", () => {
    expect(naxOwnedWriteRefusal("Write", "sub/.queue.txt")).toBeUndefined();
  });

  test("the reason names the path and says why", () => {
    const reason = naxOwnedWriteRefusal("Write", ".queue.txt");
    expect(reason).toContain(".queue.txt");
    expect(reason).toContain("run state");
  });
});

describe("naxOwnedWriteRefusal — plan-op exemption (nax#2115)", () => {
  const PRD = ".nax/features/auth/prd.json";

  test("exempts the one path the plan op declared as its fileOutput", () => {
    expect(naxOwnedWriteRefusal("Write", PRD, PRD)).toBeUndefined();
  });

  test("exemption is path-exact: another feature's PRD is still refused", () => {
    expect(naxOwnedWriteRefusal("Write", ".nax/features/billing/prd.json", PRD)).toBeDefined();
  });

  test("an absent exemption leaves the refusal exactly as it was", () => {
    expect(naxOwnedWriteRefusal("Write", PRD, undefined)).toBeDefined();
    expect(naxOwnedWriteRefusal("Write", PRD)).toBeDefined();
  });

  test("an exemption naming a non-PRD path grants nothing", () => {
    expect(naxOwnedWriteRefusal("Write", PRD, "src/index.ts")).toBeDefined();
  });

  test("read-only tools were never refused, exemption or not", () => {
    for (const tool of ["Read", "Grep", "Glob", "Git"]) {
      expect(naxOwnedWriteRefusal(tool, PRD, PRD)).toBeUndefined();
      expect(naxOwnedWriteRefusal(tool, PRD)).toBeUndefined();
    }
  });
});

// US-001: `naxOwnedKind` is the kind-aware half of the same predicate. The raw
// Bash screen needs to know WHICH kind of nax-owned file a token hit so it can
// print the matching refusal text; `isNaxOwnedWritePath` only answers yes/no.
describe("naxOwnedKind", () => {
  test("AC1: a feature PRD is the 'prd' kind", () => {
    expect(naxOwnedKind(".nax/features/f/prd.json")).toBe("prd");
  });

  test("AC1: the root queue file is the 'queue' kind", () => {
    expect(naxOwnedKind(".queue.txt")).toBe("queue");
  });

  test("AC1: the atomic-rename queue target is also the 'queue' kind", () => {
    expect(naxOwnedKind(".queue.txt.processing")).toBe("queue");
  });

  test("AC1: an ordinary prd.json outside .nax is not nax-owned", () => {
    expect(naxOwnedKind("src/prd.json")).toBeUndefined();
  });

  test("AC2: nax config files are never returned by naxOwnedKind", () => {
    // Config detection is the lexical `isNaxConfigFile` pass in the raw screen,
    // checked first, exactly as before -- naxOwnedKind must not report it.
    expect(naxOwnedKind(".nax/config.json")).toBeUndefined();
    expect(naxOwnedKind(".nax/mono/api/config.json")).toBeUndefined();
  });

  test("does not report a nested file merely named like the queue file", () => {
    expect(naxOwnedKind("sub/.queue.txt")).toBeUndefined();
  });

  test("does not report a non-prd file under a feature dir", () => {
    expect(naxOwnedKind(".nax/features/f/notes.md")).toBeUndefined();
  });
});

// US-001 AC2: the mutation-guard's verdict is unchanged by this story --
// `.nax/config.json` was never writable through `naxOwnedWriteRefusal`, and it
// still returns undefined.
describe("naxOwnedWriteRefusal — config files stay out of the write guard (US-001 AC2)", () => {
  test("AC2: naxOwnedWriteRefusal('Write', '.nax/config.json') is undefined", () => {
    expect(naxOwnedWriteRefusal("Write", ".nax/config.json")).toBeUndefined();
  });
});

describe("isNaxOwnedWritePath", () => {
  test("a feature PRD is owned", () => {
    expect(isNaxOwnedWritePath(".nax/features/my-feature/prd.json")).toBe(true);
  });

  test("a root queue-control file is owned", () => {
    expect(isNaxOwnedWritePath(".queue.txt")).toBe(true);
  });

  test("a nested file merely named like the queue file is not owned", () => {
    expect(isNaxOwnedWritePath("sub/.queue.txt")).toBe(false);
  });

  test("an ordinary source file is not owned", () => {
    expect(isNaxOwnedWritePath("src/index.ts")).toBe(false);
  });

  test("a non-prd file under a feature dir is not owned", () => {
    expect(isNaxOwnedWritePath(".nax/features/my-feature/notes.md")).toBe(false);
  });
});

// nax#2260: `.nax/` is nax's own state. File tools may write there only to the
// scratchpad, to files directly inside a feature dir (acceptance and suggested
// tests, whatever acceptance.testPath names them), and to entries a human
// opted in through execution.sandbox.filesystem.allowWrite.
describe("naxOwnedWriteRefusal — .nax/ state (nax#2260)", () => {
  test("refuses every mutating tool under rules/, context.md and the other top-level entries", () => {
    for (const rel of [
      ".nax/rules/a.md",
      ".nax/context.md",
      ".nax/constitution.md",
      ".nax/profiles/p.json",
      ".nax/cache/x",
    ]) {
      for (const tool of ["Write", "Edit", "Delete", "GitCommit"])
        expect(naxOwnedWriteRefusal(tool, rel)).toBeDefined();
    }
  });

  test("refuses the .nax directory itself", () => {
    expect(naxOwnedWriteRefusal("Delete", ".nax")).toBeDefined();
  });

  test("refuses a feature's run-state subdirectories", () => {
    expect(naxOwnedWriteRefusal("Write", ".nax/features/auth/stories/US-001/manifest.json")).toBeDefined();
    expect(naxOwnedWriteRefusal("Delete", ".nax/features/auth/sessions/s.json")).toBeDefined();
  });

  test("allows the scratchpad", () => {
    expect(naxOwnedWriteRefusal("Write", ".nax/scratchpad/probe.ts")).toBeUndefined();
    expect(naxOwnedWriteRefusal("Delete", ".nax/scratchpad/deep/notes.md")).toBeUndefined();
  });

  test("refuses a feature dir's own state and context files", () => {
    const names = [
      "context.md",
      "spec.md",
      "acceptance-meta.json",
      "acceptance-refined.json",
      "status.json",
      "checkpoint.jsonl",
      "debug-import.ts",
    ];
    for (const name of names) expect(naxOwnedWriteRefusal("Write", `.nax/features/auth/${name}`)).toBeDefined();
  });

  test("allows test-shaped files directly inside a feature dir: acceptance tests under any configured name", () => {
    for (const name of [
      ".nax-acceptance.test.ts",
      ".nax-acceptance.test.tsx",
      "_nax_acceptance_test.py",
      ".nax-acceptance_test.go",
      ".nax-acceptance.rs",
      ".nax-suggested.test.ts",
      "_nax_suggested_test.py",
      "custom.test.ts",
      "custom.spec.js",
    ]) {
      expect(naxOwnedWriteRefusal("Edit", `.nax/features/auth/${name}`)).toBeUndefined();
    }
  });

  test("the plan op's exempt path is honoured for a non-PRD .nax path too, and only that path", () => {
    expect(naxOwnedWriteRefusal("Write", ".nax/features/auth/out.json", ".nax/features/auth/out.json")).toBeUndefined();
    expect(naxOwnedWriteRefusal("Write", ".nax/features/auth/other.json", ".nax/features/auth/out.json")).toBeDefined();
  });

  test("reads are never refused", () => {
    for (const tool of ["Read", "Grep", "Glob", "Git"])
      expect(naxOwnedWriteRefusal(tool, ".nax/rules/a.md")).toBeUndefined();
  });

  test("an opted-in top-level entry becomes writable, and only that entry", () => {
    const optIns = new Set(["rules"]);
    expect(naxOwnedWriteRefusal("Edit", ".nax/rules/a.md", undefined, optIns)).toBeUndefined();
    expect(naxOwnedWriteRefusal("Edit", ".nax/context.md", undefined, optIns)).toBeDefined();
  });

  test("the reason names the path, the writable places and the opt-in", () => {
    const reason = naxOwnedWriteRefusal("Write", ".nax/rules/a.md") ?? "";
    expect(reason).toContain(".nax/rules/a.md");
    expect(reason).toContain(".nax/scratchpad/");
    expect(reason).toContain("execution.sandbox.filesystem.allowWrite");
  });

  test("the scratchpad entry matches the scratchpad tools' directory", () => {
    expect(`.nax/${NAX_SCRATCHPAD_ENTRY}`).toBe(SCRATCHPAD_DIR);
  });
});

describe("naxWriteOptIns (nax#2260)", () => {
  test("a relative, ./-prefixed, trailing-slash or absolute spelling of a top-level entry opts it in", () => {
    for (const p of [".nax/rules", "./.nax/rules/", join(ROOT, ".nax", "rules")]) {
      expect([...naxWriteOptIns(ROOT, [p])]).toEqual(["rules"]);
    }
  });

  test("features, config.json and mono can never be opted in", () => {
    expect(naxWriteOptIns(ROOT, [".nax/features", ".nax/config.json", ".nax/mono"]).size).toBe(0);
  });

  test("the scratchpad needs no opt-in and .nax itself is not an entry", () => {
    expect(naxWriteOptIns(ROOT, [".nax/scratchpad", ".nax"]).size).toBe(0);
  });

  test("a path below an entry, or outside .nax, opts nothing in", () => {
    expect(naxWriteOptIns(ROOT, [".nax/rules/a.md", "dist", "../.nax/rules"]).size).toBe(0);
  });
});
