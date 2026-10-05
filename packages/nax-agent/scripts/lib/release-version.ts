interface Version {
  major: number;
  minor: number;
  patch: number;
  prerelease?: string;
}

function parseVersion(version: string): Version {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([a-zA-Z0-9]+(?:[.-][a-zA-Z0-9]+)*))?$/.exec(version);
  if (!match) throw new Error(`Invalid release version: ${version}`);
  const [major, minor, patch] = match.slice(1, 4).map(Number);
  if (![major, minor, patch].every(Number.isSafeInteger)) throw new Error(`Invalid release version: ${version}`);
  return { major, minor, patch, ...(match[4] ? { prerelease: match[4] } : {}) };
}

export function bumpVersion(current: string, kind: string): string {
  const v = parseVersion(current);
  let next: string;
  switch (kind) {
    case "canary": {
      const canary = /^canary\.([1-9]\d*)$/.exec(v.prerelease ?? "");
      next = canary
        ? `${v.major}.${v.minor}.${v.patch}-canary.${Number(canary[1]) + 1}`
        : `${v.major}.${v.minor}.${v.patch + 1}-canary.1`;
      break;
    }
    case "promote":
      if (!/^canary\.[1-9]\d*$/.test(v.prerelease ?? "")) throw new Error(`Current version ${current} is not a canary`);
      next = `${v.major}.${v.minor}.${v.patch}`;
      break;
    case "patch":
      next = `${v.major}.${v.minor}.${v.patch + 1}`;
      break;
    case "minor":
      next = `${v.major}.${v.minor + 1}.0`;
      break;
    case "major":
      next = `${v.major + 1}.0.0`;
      break;
    default:
      next = kind;
  }
  parseVersion(next);
  return next;
}

/** Matches the library release arm in the monorepo workflow. */
export function distTagsFor(version: string): string[] {
  parseVersion(version);
  return version.includes("-canary.") ? ["canary"] : ["latest"];
}

/** Semver precedence: -1, 0 or 1. A prerelease sorts below its release; numeric identifiers compare numerically. */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  for (const key of ["major", "minor", "patch"] as const) {
    if (x[key] !== y[key]) return x[key] < y[key] ? -1 : 1;
  }
  if (x.prerelease === y.prerelease) return 0;
  if (x.prerelease === undefined) return 1;
  if (y.prerelease === undefined) return -1;
  return comparePrereleaseIdentifiers(x.prerelease, y.prerelease);
}

/** Compares dot-separated prerelease identifiers: numeric ones numerically, numeric below alphanumeric. */
function comparePrereleaseIdentifiers(left: string, right: string): number {
  const a = left.split(".");
  const b = right.split(".");
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const l = a[i];
    const r = b[i];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    const order = compareIdentifier(l, r);
    if (order !== 0) return order;
  }
  return 0;
}

/** -1 or 1 for two unequal single prerelease identifiers; 0 when equal. */
function compareIdentifier(l: string, r: string): number {
  if (l === r) return 0;
  const ln = /^\d+$/.test(l) ? Number(l) : undefined;
  const rn = /^\d+$/.test(r) ? Number(r) : undefined;
  if (ln !== undefined && rn !== undefined) return ln < rn ? -1 : 1;
  if (ln !== undefined) return -1;
  if (rn !== undefined) return 1;
  return l < r ? -1 : 1;
}

export function updateChangelog(text: string, version: string, date: string): string {
  parseVersion(version);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("Invalid release date");
  const headings = [...text.matchAll(/^## \[([^\]]+)\](?: - ([^\n]+))?$/gm)];
  const target = headings.filter((heading) => heading[1] === version);
  const unreleased = headings.filter((heading) => heading[1] === "Unreleased");
  if (target.length > 1 || unreleased.length > 1 || (target.length > 0 && unreleased.length > 0)) {
    throw new Error(`Ambiguous changelog notes for ${version}`);
  }
  const heading = target[0] ?? unreleased[0];
  if (!heading || (target.length > 0 && heading[2] !== "Unreleased")) {
    throw new Error(`Missing unreleased changelog notes for ${version}`);
  }
  const start = heading.index + heading[0].length;
  const following = headings.find((other) => other.index > heading.index);
  if (!text.slice(start, following?.index ?? text.length).trim()) {
    throw new Error(`Empty changelog notes for ${version}`);
  }
  return `${text.slice(0, heading.index)}## [${version}] - ${date}${text.slice(start)}`;
}
