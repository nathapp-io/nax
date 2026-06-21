import { describe, expect, test } from "bun:test";
import { resolveFeatureSpec } from "../../../src/cli/features-resolve";

describe("resolveFeatureSpec — not-a-nax-repo", () => {
  test("returns not-a-nax-repo when workdir has no .nax/", async () => {
    const result = await resolveFeatureSpec(undefined, "/tmp");
    expect(result.status).toBe("not-a-nax-repo");
    expect(result.message).toMatch(/not a nax repo/i);
  });
});
