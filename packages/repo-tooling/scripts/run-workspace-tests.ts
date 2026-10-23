#!/usr/bin/env bun
/** Root test entry: explicit workspace test files must not leak to sibling runners. */
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export function workspaceTestCommands(args: readonly string[], root: string): string[][] {
  const allWorkspaces = ["bun", "run", "--filter", "*", "test", ...args];
  if (args.length === 0) return [allWorkspaces];
  const byWorkspace = new Map<string, string[]>();
  for (const arg of args) {
    const file = resolve(root, arg);
    const parts = relative(root, file).split(sep);
    // Preserve the legacy CLI for flags, name filters and other non-file inputs.
    if (parts[0] !== "packages" || !parts[1] || parts.length < 4 || !file.endsWith(".test.ts")) {
      return [allWorkspaces];
    }
    const workspace = `./packages/${parts[1]}`;
    const files = byWorkspace.get(workspace) ?? [];
    files.push(file);
    byWorkspace.set(workspace, files);
  }
  return [...byWorkspace].map(([workspace, files]) => ["bun", "run", "--filter", workspace, "test", ...files]);
}

export const _workspaceTestDeps = {
  run(command: string[], cwd: string): number {
    const result = Bun.spawnSync(command, { cwd, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    if (result.signalCode) throw new Error(`[test] workspace test runner terminated by ${result.signalCode}`);
    return result.exitCode;
  },
};

export function runWorkspaceTests(args: readonly string[], root: string): number {
  for (const command of workspaceTestCommands(args, root)) {
    const exitCode = _workspaceTestDeps.run(command, root);
    if (exitCode !== 0) return exitCode;
  }
  return 0;
}

if (import.meta.main) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  process.exit(runWorkspaceTests(process.argv.slice(2), root));
}
