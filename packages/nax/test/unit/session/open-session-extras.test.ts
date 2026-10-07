import { describe, expect, test } from "bun:test";
import { openSessionExtras } from "@/session/open-session-extras";

describe("openSessionExtras", () => {
  test("derives transcriptDir from the root and feature when the caller supplied none", () => {
    expect(openSessionExtras({ featureName: "f" }, "/root")).toEqual({
      transcriptDir: "/root/features/f/sessions",
    });
  });

  test("an explicit transcriptDir wins; owner and toolAudit are forwarded when present", () => {
    const toolAudit = { dir: "/audit", header: { runId: "r", storyId: "US-001" } };
    expect(
      openSessionExtras({ featureName: "f", transcriptDir: "/explicit", transcriptOwner: "op-1", toolAudit }, "/root"),
    ).toEqual({ transcriptDir: "/explicit", transcriptOwner: "op-1", toolAudit });
  });

  test("no root and no feature: no transcriptDir key at all", () => {
    expect(openSessionExtras({}, undefined)).toEqual({ transcriptDir: undefined });
  });

  test("forwards package guidance and access restrictions to the native adapter", () => {
    const options = {
      instructionFileName: "TEAM.md",
      instructionDirectories: ["apps/api", "packages/client"],
      instructionProtectedPaths: { projectStateDir: ".nax", gitExcludePathspecs: [], gitIgnorePatterns: [] },
      instructionDenyPaths: ["docs/private/**"],
    };
    expect(openSessionExtras(options, undefined)).toEqual({ transcriptDir: undefined, ...options });
  });
});
