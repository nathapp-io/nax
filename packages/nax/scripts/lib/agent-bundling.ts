/**
 * nax bundles @nathapp/nax-agent and @nathapp/nax-agent-acp into dist/nax.js
 * instead of installing them (S1 spec section 4.1, S4b spec §8), so the
 * published package.json must never name either as a dependency, and every
 * runtime dependency of each must be one nax's consumers install. Called from
 * check-bundle-externals.
 */

export interface PackageJsonShape {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

const AGENT = "@nathapp/nax-agent";
const ACP = "@nathapp/nax-agent-acp";

function shortName(name: string): string {
  return name.replace("@nathapp/", "");
}

/**
 * A workspace package nax bundles into dist/nax.js: listed only as a
 * `workspace:*` devDependency, never `--external`, and every runtime
 * dependency of it declared by nax at the same spec, so consumers install it.
 */
export function checkBundledPackage(nax: PackageJsonShape, name: string, bundled: PackageJsonShape): string[] {
  const failures: string[] = [];
  if (nax.devDependencies?.[name] !== "workspace:*") {
    failures.push(`nax must list ${name} as a devDependency "workspace:*" (it is bundled, not installed)`);
  }
  if (nax.scripts?.build?.includes(`--external "${name}"`)) {
    failures.push(`the build script must bundle ${name}, not mark it --external`);
  }
  for (const [dep, spec] of Object.entries(bundled.dependencies ?? {})) {
    const declared = nax.dependencies?.[dep];
    if (declared !== spec) {
      failures.push(
        `${shortName(name)} depends on ${dep}@${spec}; nax must declare the same in dependencies (found ${declared})`,
      );
    }
  }
  return failures;
}

export function checkAgentBundling(nax: PackageJsonShape, agent: PackageJsonShape): string[] {
  const failures: string[] = [];
  for (const [name, spec] of Object.entries(nax.dependencies ?? {})) {
    if (spec.startsWith("workspace:")) failures.push(`nax dependency ${name} uses ${spec}; npm cannot install it`);
  }
  return [...failures, ...checkBundledPackage(nax, AGENT, agent)];
}

/** S4b-2: nax-agent-acp is bundled the same way (spec §8). */
export function checkAcpBundling(nax: PackageJsonShape, acp: PackageJsonShape): string[] {
  return checkBundledPackage(nax, ACP, acp);
}
