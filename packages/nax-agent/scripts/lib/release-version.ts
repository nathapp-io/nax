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
