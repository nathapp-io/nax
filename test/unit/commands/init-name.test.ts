import { describe, expect, it } from "bun:test";
import {
  validateProjectName,
  checkInitCollision,
  type ProjectNameValidationResult,
} from "../../../src/cli/init";

describe("validateProjectName", () => {
  it("accepts 'my-project'", () => {
    const r = validateProjectName("my-project");
    expect(r.valid).toBe(true);
  });

  it("rejects empty string", () => {
    const r = validateProjectName("");
    expect(r.valid).toBe(false);
    expect(r.error).toContain("non-empty");
  });

  it("rejects 'global'", () => {
    const r = validateProjectName("global");
    expect(r.valid).toBe(false);
    expect(r.error).toContain("reserved");
  });

  it("rejects name with uppercase", () => {
    const r = validateProjectName("MyProject");
    expect(r.valid).toBe(false);
  });

  it("rejects name starting with '_'", () => {
    const r = validateProjectName("_archive");
    expect(r.valid).toBe(false);
    expect(r.error).toContain("reserved");
  });

  it("rejects name longer than 64 chars", () => {
    const r = validateProjectName("a".repeat(65));
    expect(r.valid).toBe(false);
  });
});
