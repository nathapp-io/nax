/**
 * Resolves the manifest NAME of the workspace member at `root`.
 *
 * `yarn workspace <name> ...` and `cargo add -p <name>` take the manifest
 * name, not a path (package-managers.ts, Task 4 rule 3) — `normalizeExec`
 * DENIES rather than substituting a path when this is absent. Reading it is
 * confined to this one module so both dispatch hops resolve it identically.
 *
 * Order: package.json (Node/Bun) -> Cargo.toml [package] -> pyproject.toml
 * [project]. Each TOML match is anchored to its own section header so a
 * `[dependencies]` / `[project.dependencies]` entry naming a package "name"
 * is never mistaken for the workspace member's own name.
 */

import { join } from "node:path";

export async function resolvePackageName(root: string): Promise<string | undefined> {
  const pkgJson = Bun.file(join(root, "package.json"));
  if (await pkgJson.exists()) {
    try {
      const parsed = (await pkgJson.json()) as { name?: unknown };
      if (typeof parsed.name === "string" && parsed.name.length > 0) return parsed.name;
    } catch {
      // Malformed package.json: fall through to the other manifests rather
      // than throwing out of a plumbing helper.
    }
  }

  const cargoToml = Bun.file(join(root, "Cargo.toml"));
  if (await cargoToml.exists()) {
    const content = await cargoToml.text();
    const match = content.match(/^\[package\][^[]*name\s*=\s*"([^"]+)"/ms);
    if (match?.[1] !== undefined && match[1].length > 0) return match[1];
  }

  const pyproject = Bun.file(join(root, "pyproject.toml"));
  if (await pyproject.exists()) {
    const content = await pyproject.text();
    const match = content.match(/^\[project\][^[]*name\s*=\s*"([^"]+)"/ms);
    if (match?.[1] !== undefined && match[1].length > 0) return match[1];
  }

  return undefined;
}
