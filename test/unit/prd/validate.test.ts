import { describe, expect, test } from "bun:test";
import { validateStoryId } from "../../../src/prd/validate";

describe("validateStoryId", () => {
  test("accepts valid story IDs", () => {
    const validIds = [
      "auth-login",
      "US001",
      "feature_new_dashboard",
      "bug.fix.123",
      "api-v2-refactor",
      "a",
      "Z9",
      "test-with-many-chars-that-are-valid-123456789",
    ];

    for (const id of validIds) {
      expect(() => validateStoryId(id)).not.toThrow();
    }
  });

  test("rejects empty strings", () => {
    expect(() => validateStoryId("")).toThrow("Story ID cannot be empty");
  });

  test("rejects path traversal attempts", () => {
    expect(() => validateStoryId("../../../etc/passwd")).toThrow("Story ID cannot contain path traversal (..)");
    expect(() => validateStoryId("story..id")).toThrow("Story ID cannot contain path traversal (..)");
  });

  test("rejects git flags", () => {
    expect(() => validateStoryId("--force")).toThrow("Story ID cannot start with git flags (--)");
    expect(() => validateStoryId("--delete")).toThrow("Story ID cannot start with git flags (--)");
  });

  test("rejects IDs starting with non-alphanumeric", () => {
    expect(() => validateStoryId("-invalid")).toThrow(/pattern/);
    expect(() => validateStoryId("_invalid")).toThrow(/pattern/);
    expect(() => validateStoryId(".invalid")).toThrow(/pattern/);
  });

  test("rejects IDs with invalid characters", () => {
    expect(() => validateStoryId("invalid@id")).toThrow(/pattern/);
    expect(() => validateStoryId("invalid#id")).toThrow(/pattern/);
    expect(() => validateStoryId("invalid/id")).toThrow(/pattern/);
    expect(() => validateStoryId("invalid id")).toThrow(/pattern/);
  });

  test("rejects IDs longer than 64 characters", () => {
    const longId = "a" + "b".repeat(64); // 65 characters
    expect(() => validateStoryId(longId)).toThrow(/pattern/);
  });

  test("accepts IDs exactly 64 characters", () => {
    const id64 = "a" + "b".repeat(63); // 64 characters
    expect(() => validateStoryId(id64)).not.toThrow();
  });
});
