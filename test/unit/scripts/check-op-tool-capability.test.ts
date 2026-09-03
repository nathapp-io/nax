/**
 * The role/capability gate (nax#1800 follow-on).
 *
 * `resolveDeclaredTools` is `op.tools ?? DEFAULT_CODING_TOOLS`, so omitting the
 * field yields read-only rather than an error. That is invisible on acpx, where
 * the ACP agent brings its own tools, and silently disables an op on native.
 * This gate makes the omission loud for roles whose work requires more.
 */

import { describe, expect, test } from "bun:test";
import { collectOps, findViolations, REQUIRED_TOOLS_BY_ROLE } from "@scripts/check-op-tool-capability";
import { byCodePoint } from "@/utils/sort";

describe("REQUIRED_TOOLS_BY_ROLE", () => {
  test("a verifier must be able to run commands but never to write", () => {
    const required = REQUIRED_TOOLS_BY_ROLE.verifier;

    expect(required).toContain("RunCommand");
    expect(required).not.toContain("Write");
    expect(required).not.toContain("Edit");
  });

  test("write-capable roles require Write and Edit", () => {
    for (const role of [
      "implementer",
      "test-writer",
      "source-fix",
      "test-fix",
      "repo-scoped-test-fix",
      "fix-gen",
      "finish-fix",
    ]) {
      expect(REQUIRED_TOOLS_BY_ROLE[role]).toContain("Write");
      expect(REQUIRED_TOOLS_BY_ROLE[role]).toContain("Edit");
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
      acceptanceFixSourceOp: { kind: "run", name: "acceptance-fix-source", session: { role: "source-fix" } },
      acceptanceFixTestOp: { kind: "run", name: "acceptance-fix-test", session: { role: "test-fix" } },
    });

    expect(rows.map((r) => r.name).sort(byCodePoint)).toEqual(["acceptance-fix-source", "acceptance-fix-test"]);
  });

  test("an op with no tools field reports the read-only default, not an empty set", () => {
    const rows = collectOps({ verifierOp: { kind: "run", name: "verifier", session: { role: "verifier" } } });

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
    const rows = [{ name: "test-writer", role: "test-writer", tools: ["Read", "Write", "Edit", "RunCommand"] }];

    expect(findViolations(rows, [])).toEqual([]);
  });

  test("a role with no entry in the table is unconstrained", () => {
    const rows = [{ name: "semantic-review", role: "reviewer-semantic", tools: ["Read"] }];

    expect(findViolations(rows, [])).toEqual([]);
  });
});
