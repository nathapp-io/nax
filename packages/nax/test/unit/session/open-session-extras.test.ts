import { describe, expect, test } from "bun:test";
import type { NaxConfig } from "@/config";
import { NaxConfigSchema } from "@/config/schema";
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

  test("sandbox is forwarded when present and absent otherwise (nax#2500)", () => {
    const sandbox = { kind: "unavailable", reason: "test" } as const;
    expect(openSessionExtras({ sandbox }, undefined).sandbox).toEqual(sandbox);
    expect("sandbox" in openSessionExtras({}, undefined)).toBe(false);
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

  describe("transcriptArchive (#2453)", () => {
    const configWith = (transcriptAudit: Record<string, unknown>): Pick<NaxConfig, "agent"> =>
      NaxConfigSchema.parse({ agent: { transcriptAudit } });
    const audit = (extra: Record<string, unknown> = {}) => configWith({ enabled: true, maxRetained: 7, ...extra });

    test("enabled with no dir archives under <transcriptRoot>/transcript-audit/<feature>", () => {
      expect(openSessionExtras({ featureName: "f" }, "/root", audit()).transcriptArchive).toEqual({
        dir: "/root/transcript-audit/f",
        maxRetained: 7,
      });
    });

    test("a configured dir is used as <dir>/<feature>", () => {
      expect(openSessionExtras({ featureName: "f" }, "/root", audit({ dir: "/custom" })).transcriptArchive).toEqual({
        dir: "/custom/f",
        maxRetained: 7,
      });
      expect(openSessionExtras({ featureName: "f" }, undefined, audit({ dir: "/custom" })).transcriptArchive?.dir).toBe(
        "/custom/f",
      );
    });

    test("omitted when disabled, when the feature is missing, or when no root and no dir", () => {
      const disabled = configWith({ enabled: false, maxRetained: 7 });
      expect("transcriptArchive" in openSessionExtras({ featureName: "f" }, "/root", disabled)).toBe(false);
      expect("transcriptArchive" in openSessionExtras({ featureName: "f" }, "/root", undefined)).toBe(false);
      expect("transcriptArchive" in openSessionExtras({}, "/root", audit())).toBe(false);
      expect("transcriptArchive" in openSessionExtras({ featureName: "f" }, undefined, audit())).toBe(false);
    });
  });
});
