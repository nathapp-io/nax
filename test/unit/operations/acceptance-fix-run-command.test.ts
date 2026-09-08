/**
 * #1936: acceptance-fix-source and acceptance-fix-test both declare "Exec",
 * but Exec is only a marker that switches on RunCommand's argv branch
 * (coding-tool-support.ts) -- it grants nothing on its own. Without
 * "RunCommand" in `tools`, the RunCommand tool object is built and wired
 * (declaredCommands is non-empty and Exec is declared) and then thrown away
 * by runtime.advertised(), because advertised is driven by the op's own
 * declared list. A fix session that cannot run a command cannot re-run the
 * test it is fixing.
 *
 * Asserted two ways: against the barrel declaration directly, and against
 * the real advertised-tool set built the way a dispatch builds it, so a
 * regression that only touches coding-tool-support's filtering (rather than
 * the op's declared list) still fails here.
 */

import { describe, expect, test } from "bun:test";
import { makeNaxConfig } from "@test/helpers";
import { buildCodingToolSupport } from "@/agents/coding-tool-support";
import { resolvePermissions } from "@/config/permissions";
import { acceptanceFixSourceOp, acceptanceFixTestOp } from "@/operations";
import { resolveDeclaredTools } from "@/operations/types";

describe("acceptance-fix RunCommand declaration (#1936)", () => {
  test("acceptance-fix-source declares RunCommand", () => {
    expect(resolveDeclaredTools(acceptanceFixSourceOp)).toContain("RunCommand");
  });

  test("acceptance-fix-test declares RunCommand", () => {
    expect(resolveDeclaredTools(acceptanceFixTestOp)).toContain("RunCommand");
  });

  test("both ops keep the Exec marker alongside RunCommand", () => {
    expect(resolveDeclaredTools(acceptanceFixSourceOp)).toContain("Exec");
    expect(resolveDeclaredTools(acceptanceFixTestOp)).toContain("Exec");
  });

  test("RunCommand is actually advertised to a source-fix dispatch under an unrestricted profile", () => {
    const config = makeNaxConfig({ execution: { permissionProfile: "unrestricted" } });
    const resolved = resolvePermissions(config, "acceptance");
    const grants = resolved.toolGrants ?? [];
    const declaredCommands = new Map([["testScoped", "CI=1 AGENT=1 bun test --timeout=60000 {{files}}"]]);
    const support = buildCodingToolSupport({
      root: process.cwd(),
      grants,
      declared: resolveDeclaredTools(acceptanceFixSourceOp),
      declaredCommands,
      sessionName: "probe",
    });

    expect(support?.tools.map((t) => t.name)).toContain("RunCommand");
  });
});
