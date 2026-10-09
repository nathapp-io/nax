import { describe, expect, test } from "bun:test";
import {
  bumpVersion,
  compareVersions,
  distTagsFor,
  NO_CHANGES,
  nextSharedVersion,
  stampChangelog,
  updateChangelog,
} from "#scripts/lib/release-version";

describe("release version decisions", () => {
  test.each([
    ["0.1.0", "patch", "0.1.1"],
    ["0.1.0", "minor", "0.2.0"],
    ["0.1.0", "major", "1.0.0"],
    ["0.1.0", "canary", "0.1.1-canary.1"],
    ["0.1.1-canary.1", "canary", "0.1.1-canary.2"],
    ["0.1.1-canary.2", "promote", "0.1.1"],
    ["0.1.0", "0.2.0", "0.2.0"],
  ])("%s %s becomes %s", (current, kind, expected) => expect(bumpVersion(current, kind)).toBe(expected));

  test.each(["bad", "0.1", "01.2.3", "0.2.0;echo bad", "0.2.0+shell", "99999999999999999999.0.0"])(
    "rejects invalid explicit %s",
    (kind) => {
      expect(() => bumpVersion("0.1.0", kind)).toThrow();
    },
  );
  test("rejects invalid current versions and promotion of stable versions", () => {
    expect(() => bumpVersion("bad", "patch")).toThrow();
    expect(() => bumpVersion("0.1.0", "promote")).toThrow();
    expect(() => bumpVersion("0.1.1-beta.1", "promote")).toThrow();
  });
  test("maps stable to latest and canary to canary", () => {
    expect(distTagsFor("0.1.0")).toEqual(["latest"]);
    expect(distTagsFor("1.0.0")).toEqual(["latest"]);
    expect(distTagsFor("0.1.1-canary.1")).toEqual(["canary"]);
  });
  test("compareVersions orders by semver precedence; a canary sorts below its release", () => {
    expect(compareVersions("0.3.0", "0.3.0")).toBe(0);
    expect(compareVersions("0.2.1", "0.3.0")).toBeLessThan(0);
    expect(compareVersions("0.10.0", "0.9.9")).toBeGreaterThan(0);
    expect(compareVersions("0.3.0-canary.1", "0.3.0")).toBeLessThan(0);
    expect(compareVersions("0.3.0-canary.10", "0.3.0-canary.9")).toBeGreaterThan(0);
    expect(compareVersions("0.3.1-canary.1", "0.3.0")).toBeGreaterThan(0);
  });
});

describe("release notes", () => {
  test("dates the first release's existing notes without replacing them", () => {
    expect(updateChangelog("# Changelog\n\n## [0.1.0] - Unreleased\n\n- Native agent.\n", "0.1.0", "2026-10-03")).toBe(
      "# Changelog\n\n## [0.1.0] - 2026-10-03\n\n- Native agent.\n",
    );
  });
  test("promotes Unreleased notes to the requested version and retains history", () => {
    const text = "# Changelog\n\n## [Unreleased]\n\n- New tools.\n\n## [0.1.0] - 2026-10-03\n\n- Native agent.\n";
    expect(updateChangelog(text, "0.1.1", "2026-10-04")).toBe(
      "# Changelog\n\n## [0.1.1] - 2026-10-04\n\n- New tools.\n\n## [0.1.0] - 2026-10-03\n\n- Native agent.\n",
    );
  });
  test.each([
    "# Changelog\n",
    "## [Unreleased]\n\n## [0.1.0] - 2026-10-03\nOld.\n",
    "## [0.1.1] - Unreleased\nA\n## [0.1.1] - Unreleased\nB\n",
    "## [0.1.1] - 2026-10-03\nOld\n## [Unreleased]\nNew\n",
    "## [Unreleased]\nNew\n## [Unreleased]\nOther\n",
  ])("refuses absent, empty or ambiguous notes", (text) => {
    expect(() => updateChangelog(text, "0.1.1", "2026-10-04")).toThrow();
  });
});

describe("next shared version", () => {
  test.each([
    ["0.84.0", "patch", "0.84.1"],
    ["0.84.0", "minor", "0.85.0"],
    ["0.84.0", "canary", "0.84.1-canary.1"],
    ["0.84.0", "0.90.0", "0.90.0"],
  ])("%s %s becomes %s", (current, kind, expected) => expect(nextSharedVersion(current, kind)).toBe(expected));

  test.each(["0.84.0", "0.83.9", "0.84.0-canary.1"])("refuses %s, which is not above 0.84.0", (kind) => {
    expect(() => nextSharedVersion("0.84.0", kind)).toThrow(/above/);
  });

  test("refuses a prerelease the release workflow would not accept", () => {
    expect(() => nextSharedVersion("0.84.0", "0.85.0-rc.1")).toThrow(/X\.Y\.Z-canary\.N/);
  });
});

describe("lockstep release notes", () => {
  const dated = `# Changelog\n\n## [0.84.1] - 2026-10-10\n\n${NO_CHANGES}\n\n## [0.84.0] - 2026-10-09\n\n- Old.\n`;

  test("dates real Unreleased notes exactly like updateChangelog", () => {
    const text = "# Changelog\n\n## [Unreleased]\n\n- New.\n\n## [0.84.0] - 2026-10-09\n\n- Old.\n";
    expect(stampChangelog(text, "0.84.1", "2026-10-10")).toBe(updateChangelog(text, "0.84.1", "2026-10-10"));
  });

  test("an empty Unreleased heading becomes a dated no-changes entry", () => {
    const text = "# Changelog\n\n## [Unreleased]\n\n## [0.84.0] - 2026-10-09\n\n- Old.\n";
    expect(stampChangelog(text, "0.84.1", "2026-10-10")).toBe(dated);
  });

  test("no pending heading puts the entry above the newest release", () => {
    expect(stampChangelog("# Changelog\n\n## [0.84.0] - 2026-10-09\n\n- Old.\n", "0.84.1", "2026-10-10")).toBe(dated);
  });

  test("a changelog with no releases gets the entry appended", () => {
    expect(stampChangelog("# Changelog\n", "0.84.1", "2026-10-10")).toBe(
      `# Changelog\n\n## [0.84.1] - 2026-10-10\n\n${NO_CHANGES}\n`,
    );
  });

  test("refuses an already-dated version and ambiguous notes", () => {
    expect(() => stampChangelog("## [0.84.1] - 2026-10-09\n\n- x\n", "0.84.1", "2026-10-10")).toThrow(/already/);
    expect(() => stampChangelog("## [Unreleased]\nA\n## [Unreleased]\nB\n", "0.84.1", "2026-10-10")).toThrow();
  });
});
