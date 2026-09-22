import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  isNaxConfigFile,
  isNaxOwnedWritePath,
  NAX_OWNED_WRITE_TOOLS,
  naxOwnedWriteRefusal,
} from "@/tools/nax-owned-writes";

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

  test("allows writes elsewhere under .nax/features", () => {
    expect(naxOwnedWriteRefusal("Write", ".nax/features/auth/notes.md")).toBeUndefined();
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
