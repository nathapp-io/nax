import { describe, expect, test } from "bun:test";
// biome-ignore lint/style/noRestrictedImports: release decisions are script helpers, outside the source surface
import { bumpVersion, distTagsFor, updateChangelog } from "../../../scripts/lib/release-version.ts";

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
