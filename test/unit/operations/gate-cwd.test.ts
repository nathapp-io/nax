import { describe, expect, test } from "bun:test";
import { makeConfigSlice } from "@test/helpers";
import type { NaxConfig } from "@/config";
import { resolveGateCwd } from "@/operations/gate-cwd";
import type { PackageView } from "@/runtime";

type QualityCommands = NonNullable<NaxConfig["quality"]>["commands"];
type ReviewCommands = NonNullable<NaxConfig["review"]["commands"]>;

/**
 * A raw per-package overlay exactly as `.nax/mono/<pkg>/config.json` supplies it:
 * only the named commands are declared, nothing is inherited from the root config.
 */
function overlayWithQuality(commands: Partial<QualityCommands>): Partial<NaxConfig> {
  return { quality: makeConfigSlice("quality", { commands }) };
}

function overlayWithReview(commands: Partial<ReviewCommands>): Partial<NaxConfig> {
  return { review: makeConfigSlice("review", { commands }) };
}

/** The `pick` of PackageView the resolver actually reads. Absent overlay = no property. */
function packageView(repoRoot: string, rawOverlay?: Partial<NaxConfig>): Pick<PackageView, "overlay" | "repoRoot"> {
  return rawOverlay === undefined ? { repoRoot } : { repoRoot, overlay: rawOverlay };
}

describe("resolveGateCwd — US-002: cwd follows the command's provenance", () => {
  test("US-002 AC1: lint falls back to repoRoot when the overlay declares only quality.commands.test", () => {
    const result = resolveGateCwd({
      commandName: "lint",
      detected: false,
      packageView: packageView("/r", overlayWithQuality({ test: "bun test" })),
      workdir: "/r/packages/lib",
    });

    expect(result).toEqual({ cwd: "/r", provenance: "root" });
  });

  test("US-002 AC2: lint runs in the package workdir when the overlay declares quality.commands.lint", () => {
    const result = resolveGateCwd({
      commandName: "lint",
      detected: false,
      packageView: packageView("/r", overlayWithQuality({ lint: "eslint ." })),
      workdir: "/r/packages/lib",
    });

    expect(result).toEqual({ cwd: "/r/packages/lib", provenance: "overlay" });
  });

  test("US-002 AC3: test reports overlay provenance when only overlay review.commands.test is declared", () => {
    const result = resolveGateCwd({
      commandName: "test",
      detected: false,
      packageView: packageView("/r", overlayWithReview({ test: "bun test" })),
      workdir: "/r/packages/lib",
    });

    expect(result.provenance).toBe("overlay");
    expect(result.cwd).toBe("/r/packages/lib");
  });

  test("US-002 AC4: detected command runs in the package workdir with detected provenance", () => {
    const result = resolveGateCwd({
      commandName: "lint",
      detected: true,
      packageView: packageView("/r"),
      workdir: "/r/packages/app",
    });

    expect(result).toEqual({ cwd: "/r/packages/app", provenance: "detected" });
  });

  test("US-002 AC5: no overlay and nothing detected falls back to the repo root", () => {
    const result = resolveGateCwd({
      commandName: "lint",
      detected: false,
      packageView: packageView("/r"),
      workdir: "/r/packages/lib",
    });

    expect(result).toEqual({ cwd: "/r", provenance: "root" });
  });

  test("US-002 AC6: an empty overlay declares nothing, so the cwd is the repo root", () => {
    const result = resolveGateCwd({
      commandName: "typecheck",
      detected: false,
      packageView: packageView("/r", {}),
      workdir: "/r/packages/lib",
    });

    expect(result).toEqual({ cwd: "/r", provenance: "root" });
  });
});
