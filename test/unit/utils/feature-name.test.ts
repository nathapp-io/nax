/**
 * `validateFeatureName` guards feature names that become directory segments —
 * an unchecked value here is a path-traversal seam (see `..` and separator
 * checks below).
 */
import { describe, expect, test } from "bun:test";
import { validateFeatureName } from "@/utils/feature-name";

describe("validateFeatureName", () => {
  test("accepts a simple alphanumeric name", () => {
    expect(() => validateFeatureName("my-feature")).not.toThrow();
  });

  test("accepts dots and underscores within the allowed pattern", () => {
    expect(() => validateFeatureName("feature_v1.2")).not.toThrow();
  });

  test("throws on an empty name", () => {
    expect(() => validateFeatureName("")).toThrow("Feature name must be non-empty");
  });

  test("throws on a whitespace-only name", () => {
    expect(() => validateFeatureName("   ")).toThrow("Feature name must be non-empty");
  });

  test("throws when the name contains a forward slash", () => {
    expect(() => validateFeatureName("foo/bar")).toThrow("Feature name must be a single path segment: foo/bar");
  });

  test("throws when the name contains a backslash", () => {
    expect(() => validateFeatureName("foo\\bar")).toThrow("Feature name must be a single path segment: foo\\bar");
  });

  test("throws when the name contains '..'", () => {
    expect(() => validateFeatureName("..secret")).toThrow("Feature name cannot contain '..': ..secret");
  });

  test("throws when the name has invalid characters", () => {
    expect(() => validateFeatureName("foo bar")).toThrow("Feature name contains invalid characters: foo bar");
  });

  test("throws when the name starts with a character outside the pattern", () => {
    expect(() => validateFeatureName("-leading-dash")).toThrow(
      "Feature name contains invalid characters: -leading-dash",
    );
  });

  test("throws when the name exceeds 128 characters", () => {
    const tooLong = `a${"b".repeat(128)}`;
    expect(() => validateFeatureName(tooLong)).toThrow(`Feature name contains invalid characters: ${tooLong}`);
  });

  test("accepts a name at exactly the 128-character limit", () => {
    const atLimit = `a${"b".repeat(127)}`;
    expect(() => validateFeatureName(atLimit)).not.toThrow();
  });
});
