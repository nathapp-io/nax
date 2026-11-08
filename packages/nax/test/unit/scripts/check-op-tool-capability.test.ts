/**
 * The role/capability gate (nax#1800 follow-on).
 *
 * `resolveDeclaredTools` is `op.tools ?? DEFAULT_CODING_TOOLS`, so omitting the
 * field yields read-only rather than an error. That is invisible on acpx, where
 * the ACP agent brings its own tools, and silently disables an op on native.
 * This gate makes the omission loud for roles whose work requires more.
 */

import { describe, expect, test } from "bun:test";
import { byCodePoint } from "@nathapp/nax-agent/internal";
import { collectOps, findViolations, REQUIRED_TOOLS_BY_ROLE } from "@scripts/check-op-tool-capability";

describe("REQUIRED_TOOLS_BY_ROLE", () => {
  test("US-003 AC-5: the table covers exactly the three live roles", () => {
    expect(Object.keys(REQUIRED_TOOLS_BY_ROLE).sort()).toEqual(["implementer", "plan", "plan-refine"]);
  });

  test("write-capable roles require Write and Edit", () => {
    for (const role of ["implementer"]) {
      expect(REQUIRED_TOOLS_BY_ROLE[role]).toContain("Write");
      expect(REQUIRED_TOOLS_BY_ROLE[role]).toContain("Edit");
    }
  });

  test("fileOutput-shaped roles require Write only — they author one fresh file, never edit an existing one", () => {
    for (const role of ["plan", "plan-refine"]) {
      expect(REQUIRED_TOOLS_BY_ROLE[role]).toContain("Write");
      expect(REQUIRED_TOOLS_BY_ROLE[role]).not.toContain("Edit");
    }
  });
});

describe("collectOps", () => {
  test("dedupes ops exported under more than one alias", () => {
    const shared = { kind: "run", name: "implementer", session: { role: "implementer" }, tools: ["Write", "Edit"] };

    const rows = collectOps({ implementerOp: shared, implementTddOp: shared });

    expect(rows).toHaveLength(1);
  });

  test("collects two distinct ops defined in one module", () => {
    const rows = collectOps({
      workflowImplementOp: { kind: "run", name: "workflow-implement", session: { role: "implementer" } },
      planOpFixture: { kind: "run", name: "plan-fixture", session: { role: "plan" } },
    });

    expect(rows.map((r) => r.name).sort(byCodePoint)).toEqual(["plan-fixture", "workflow-implement"]);
  });

  test("an op with no tools field reports the read-only default, not an empty set", () => {
    const rows = collectOps({ implementerOp: { kind: "run", name: "implementer", session: { role: "implementer" } } });

    expect(rows[0]?.tools).toEqual(["Read", "Glob", "Grep"]);
  });

  test("ignores exports that are not run operations", () => {
    const rows = collectOps({
      helper: () => "not an op",
      planOp: { kind: "compute", name: "plan", session: { role: "plan" } },
    });

    expect(rows).toEqual([]);
  });
});

describe("findViolations", () => {
  test("reports the specific tools a role requires and the op omits", () => {
    const rows = [{ name: "rectify", role: "implementer", tools: ["Read", "Glob", "Grep"] }];

    const violations = findViolations(rows, []);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.missing).toEqual(["Write", "Edit"]);
  });

  test("a baselined op is not a violation", () => {
    const rows = [{ name: "rectify", role: "implementer", tools: ["Read", "Glob", "Grep"] }];

    expect(findViolations(rows, ["rectify"])).toEqual([]);
  });

  test("a declared op passes", () => {
    const rows = [{ name: "implementer", role: "implementer", tools: ["Read", "Write", "Edit", "RunCommand"] }];

    expect(findViolations(rows, [])).toEqual([]);
  });

  test("a role with no entry in the table is unconstrained", () => {
    const rows = [{ name: "semantic-review", role: "reviewer-semantic", tools: ["Read"] }];

    expect(findViolations(rows, [])).toEqual([]);
  });

  test("an implementer op missing Edit is a violation", () => {
    const rows = [{ name: "workflow-implement", role: "implementer", tools: ["Read", "Write"] }];

    const violations = findViolations(rows, []);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.missing).toEqual(["Edit"]);
  });
});
