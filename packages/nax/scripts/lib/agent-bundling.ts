/**
 * nax bundles @nathapp/nax-agent into dist/nax.js instead of installing it
 * (S1 spec section 4.1), so the published package.json must never name it as a
 * dependency, and every runtime dependency of nax-agent must be one nax's
 * consumers install. Called from check-bundle-externals.
 */

export interface PackageJsonShape {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

const AGENT = "@nathapp/nax-agent";

export function checkAgentBundling(nax: PackageJsonShape, agent: PackageJsonShape): string[] {
  const failures: string[] = [];
  for (const [name, spec] of Object.entries(nax.dependencies ?? {})) {
    if (spec.startsWith("workspace:")) failures.push(`nax dependency ${name} uses ${spec}; npm cannot install it`);
  }
  if (nax.devDependencies?.[AGENT] !== "workspace:*") {
    failures.push(`nax must list ${AGENT} as a devDependency "workspace:*" (it is bundled, not installed)`);
  }
  if (nax.scripts?.build?.includes(`--external "${AGENT}"`)) {
    failures.push(`the build script must bundle ${AGENT}, not mark it --external`);
  }
  for (const [name, spec] of Object.entries(agent.dependencies ?? {})) {
    const declared = nax.dependencies?.[name];
    if (declared !== spec) {
      failures.push(
        `nax-agent depends on ${name}@${spec}; nax must declare the same in dependencies (found ${declared})`,
      );
    }
  }
  return failures;
}
