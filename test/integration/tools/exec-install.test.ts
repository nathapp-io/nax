/**
 * Regression test for the 2026-09-06 hello-lint defect (task-11 of the
 * native-exec-allowlist spec).
 *
 * A native agent hit a missing `bun-types` package with no legal way to
 * install it (`RunCommand`/`Exec` denied, `Glob` errored, `RequestCapability`
 * empty) and, having no path to install, deleted the `types` requirement from
 * `tsconfig.json` instead. The story then "passed".
 *
 * This test proves the fixed shape: with `Exec` granted, a story CAN install
 * a missing dependency instead of deleting the requirement, and the proof is
 * read back from the durable ledger (`tool-audit.ts`) rather than from the
 * fact that Exec was merely configured — ADR-029 records a case where every
 * declared tool was measured as granted and advertised none, so "granted"
 * alone is not evidence of "invoked".
 *
 * Hermetic: the dependency lives inside the fixture's own temp dir
 * (`vendor/local-types`) and is installed by path, never by registry name, so
 * `bun add` never reaches the network. This is a real, unmocked spawn of the
 * `bun` binary — deliberately so: mocking `Bun.spawn` here would silently
 * recreate the exact failure mode this test exists to catch (a "passing" tool
 * call that never actually touched the manifest).
 */
import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withTempDir } from "@test/helpers";
import { buildCodingToolSupport } from "@/agents/coding-tool-support";

interface LedgerRow {
  readonly tool: string;
  readonly outcome: string;
  readonly input?: { readonly argv?: unknown };
  readonly executed?: readonly string[];
  readonly target?: string;
}

interface Ledger {
  readonly sessionName: string;
  readonly calls: readonly LedgerRow[];
}

async function seedRepo(root: string): Promise<{ auditDir: string }> {
  // The dependency the tsconfig needs is deliberately NOT declared: this is
  // the shape that made the 2026-09-06 run delete the requirement instead of
  // installing it.
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "fx", version: "0.0.1", private: true, devDependencies: {} }, null, 2),
  );
  await writeFile(
    join(root, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { types: ["local-types"], noEmit: true }, include: ["src/**/*"] }, null, 2),
  );

  // A local package on disk, so bun add resolves it by path and never
  // touches a registry.
  const dep = join(root, "vendor", "local-types");
  await mkdir(dep, { recursive: true });
  await writeFile(
    join(dep, "package.json"),
    JSON.stringify({ name: "local-types", version: "1.0.0", types: "index.d.ts" }),
  );
  await writeFile(join(dep, "index.d.ts"), "declare const _localTypes: true;\n");

  const auditDir = join(root, "audit");
  await mkdir(auditDir, { recursive: true });
  return { auditDir };
}

describe("Exec installs a missing dependency", () => {
  test("the manifest gains the dependency and the ledger proves Exec ran", async () => {
    await withTempDir(async (root) => {
      const { auditDir } = await seedRepo(root);

      const support = buildCodingToolSupport({
        root,
        repoRoot: root,
        grants: [
          { tool: "RunCommand", patterns: ["*"] },
          { tool: "Exec", patterns: ["bun add*"] },
        ],
        declared: ["RunCommand", "Exec"],
        declaredCommands: new Map([["typecheck", "bun x tsc --noEmit"]]),
        auditDir,
        sessionName: "US-001-implementer",
        storyId: "US-001",
      });
      expect(support).toBeDefined();

      const outcome = await support?.runtime.callTool("RunCommand", {
        argv: ["bun", "add", "-d", "./vendor/local-types"],
        target: "package",
      });
      expect(outcome?.kind).toBe("ok");

      // Property 3: the manifest must actually change. A passing tool call
      // that installed nothing is exactly the failure this test exists to
      // catch.
      const manifest: { devDependencies?: Record<string, string> } = await Bun.file(join(root, "package.json")).json();
      expect(Object.keys(manifest.devDependencies ?? {})).toContain("local-types");

      // Property 1: read the fact that Exec ran from the LEDGER, not from
      // how support was configured.
      await support?.auditSink.flush();
      const ledgerFiles = await Array.fromAsync(new Bun.Glob("*.json").scan(auditDir));
      expect(ledgerFiles.length).toBe(1);
      const ledgerFile = ledgerFiles[0];
      if (ledgerFile === undefined) throw new Error("expected exactly one ledger file");
      const ledger: Ledger = await Bun.file(join(auditDir, ledgerFile)).json();

      const row = ledger.calls.find((call) => call.input?.argv !== undefined);
      if (row === undefined) throw new Error("ledger has no row carrying the argv call");

      expect(row.tool).toBe("Exec");
      expect(row.outcome).toBe("ok");
      // Property 4: the executed argv carries the no-scripts flag, and
      // `target` is recorded — both read from the ledger row.
      expect(row.executed).toContain("--ignore-scripts");
      expect(row.target).toBe("package");
    });
  });
});
