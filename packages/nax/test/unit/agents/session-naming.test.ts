import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { computeAcpHandle } from "@/agents/session-naming";

const hash8 = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 8);

describe("computeAcpHandle", () => {
  const workdir = "/tmp/test-project";

  test("produces stable handle for implementer role", () => {
    const actual = computeAcpHandle(workdir, "my-feat", "US-001", "implementer");
    const again = computeAcpHandle(workdir, "my-feat", "US-001", "implementer");
    expect(actual).toBe(again);
  });

  test("includes role suffix for reviewer session", () => {
    const actual = computeAcpHandle(workdir, "my-feat", "US-001", "reviewer-semantic");
    expect(actual.endsWith("-reviewer-semantic")).toBe(true);
  });

  test("omits absent parts", () => {
    expect(computeAcpHandle("/repo")).toBe(`nax-${hash8("/repo")}`);
    expect(computeAcpHandle("/repo", undefined, "US-1")).toBe(`nax-${hash8("/repo")}-us-1`);
  });

  test("sanitises each part to lowercase dash-separated text and trims dashes", () => {
    expect(computeAcpHandle("/repo", " My Feat!! ", "US_002", "--Reviewer Semantic--")).toBe(
      `nax-${hash8("/repo")}-my-feat-us-002-reviewer-semantic`,
    );
  });

  test("different workdirs give different hashes for the same feature and story", () => {
    expect(computeAcpHandle("/a", "f", "s")).not.toBe(computeAcpHandle("/b", "f", "s"));
  });
});
