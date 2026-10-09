/**
 * Lockstep versioning: the four published nax packages always share one version,
 * released by one PR and one `vX.Y.Z` tag. LOCKSTEP_PACKAGES is publish order:
 * each package's runtime dependencies come before it.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface LockstepPackage {
  readonly dir: string;
  readonly name: string;
}

export const LOCKSTEP_PACKAGES: readonly LockstepPackage[] = [
  { dir: "packages/nax-ai", name: "@nathapp/nax-ai" },
  { dir: "packages/nax-agent", name: "@nathapp/nax-agent" },
  { dir: "packages/nax-agent-acp", name: "@nathapp/nax-agent-acp" },
  { dir: "packages/nax", name: "@nathapp/nax" },
];

export const NAX_AI = "@nathapp/nax-ai";

/** Exact-pin consumers of nax-ai. nax reads its pin as the catalog version (src/agents/catalog/index.ts). */
export const NAX_AI_CONSUMERS: readonly string[] = ["packages/nax", "packages/nax-agent"];

/** Packages whose CHANGELOG.md holds per-release notes. nax uses GitHub Releases; nax-ai has no changelog. */
export const CHANGELOG_PACKAGES: readonly string[] = ["packages/nax-agent", "packages/nax-agent-acp"];

export interface Manifest {
  readonly version: string;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly [key: string]: unknown;
}

/** Keyed by package dir, in LOCKSTEP_PACKAGES order. */
export type Manifests = ReadonlyMap<string, Manifest>;

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/;

export function readManifests(root: string): Manifests {
  return new Map(
    LOCKSTEP_PACKAGES.map(({ dir }) => [dir, JSON.parse(readFileSync(join(root, dir, "package.json"), "utf8"))]),
  );
}

export function writeManifests(root: string, manifests: Manifests): void {
  for (const [dir, manifest] of manifests) {
    writeFileSync(join(root, dir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  }
}

/** Every broken lockstep rule; empty when the workspace is releasable at one version. */
export function lockstepErrors(manifests: Manifests, expected?: string): string[] {
  const shared = manifests.get(LOCKSTEP_PACKAGES[0]?.dir ?? "")?.version ?? "";
  const versions = new Set([...manifests.values()].map((m) => m.version));
  const listed = [...manifests].map(([dir, m]) => `${dir}@${m.version}`).join(", ");
  const errors: string[] = [];
  if (versions.size !== 1) errors.push(`versions differ: ${listed} (bump every package in one PR)`);
  if (!SEMVER.test(shared)) errors.push(`invalid shared version "${shared}"`);
  if (expected !== undefined && shared !== expected) errors.push(`shared version ${shared} != expected ${expected}`);
  for (const dir of NAX_AI_CONSUMERS) {
    const pin = manifests.get(dir)?.dependencies?.[NAX_AI];
    if (pin !== shared) errors.push(`${dir}: ${NAX_AI} must be pinned to exactly ${shared}, found ${pin ?? "nothing"}`);
  }
  return errors;
}

/** New manifests at `next`, with the nax-ai pins moved too. Key order is kept, so the diff stays minimal. */
export function withVersion(manifests: Manifests, next: string): Manifests {
  return new Map([...manifests].map(([dir, manifest]) => [dir, bumped(dir, manifest, next)]));
}

function bumped(dir: string, manifest: Manifest, next: string): Manifest {
  if (!NAX_AI_CONSUMERS.includes(dir)) return { ...manifest, version: next };
  return { ...manifest, version: next, dependencies: { ...manifest.dependencies, [NAX_AI]: next } };
}
