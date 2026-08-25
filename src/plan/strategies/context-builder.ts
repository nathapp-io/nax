import { join } from "node:path";
import {
  buildPackageSummary,
  buildSourceRootsSection,
  createPlanRuntime,
  DEFAULT_TIMEOUT_SECONDS,
  detectProjectName,
} from "@/cli";
import type { NaxConfig } from "@/config";
import { planConfigSelector } from "@/config";
import { NaxError } from "@/errors";
import { buildInteractionBridge } from "@/interaction";
import { validateFeatureName } from "@/utils/feature-name";
import type { PlanCommandOptions, PlanDeps, PlanModeContext } from "./types";

export async function buildPlanModeContext(
  workdir: string,
  fullConfig: NaxConfig,
  options: PlanCommandOptions,
  deps: PlanDeps,
): Promise<PlanModeContext> {
  const naxDir = join(workdir, ".nax");
  if (!deps.existsSync(naxDir)) {
    throw new NaxError(`.nax directory not found. Run 'nax init' first in ${workdir}`, "PLAN_CONTEXT_NO_NAX_DIR", {
      stage: "plan",
      workdir,
    });
  }
  validateFeatureName(options.feature);
  const outputDir = join(naxDir, "features", options.feature);
  const outputPath = join(outputDir, "prd.json");

  const [specContent, sourceRoots, pkg] = await Promise.all([
    deps.readFile(options.from),
    deps.scanSourceRoots(workdir),
    deps.readPackageJson(workdir),
  ]);

  const normalizedRoots = sourceRoots.map((root) => ({
    ...root,
    path: root.path.startsWith("/") ? root.path.replace(`${workdir}/`, "") : root.path,
  }));
  const codebaseContext = buildSourceRootsSection(normalizedRoots);

  const relativePackages = [
    ...new Set(
      sourceRoots
        .map((root) => root.path)
        .filter((path) => path !== ".")
        .map((path) => (path.startsWith("/") ? path.replace(`${workdir}/`, "") : path)),
    ),
  ];

  const packageDetails =
    relativePackages.length === 0
      ? []
      : await Promise.all(
          relativePackages.map(async (relativePath) => {
            const packageJson = await deps.readPackageJsonAt(join(workdir, relativePath, "package.json"));
            return buildPackageSummary(relativePath, packageJson);
          }),
        );

  const projectName = detectProjectName(workdir, pkg);
  const branchName = options.branch ?? `feat/${options.feature}`;
  const timeoutSeconds = fullConfig?.plan?.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
  const config = planConfigSelector.select(fullConfig);
  const profileName = typeof fullConfig?.profile === "string" && fullConfig.profile ? fullConfig.profile : undefined;
  const runtime = createPlanRuntime(fullConfig, workdir, options.feature);
  const interactionChain = fullConfig ? await deps.initInteractionChain(fullConfig, !process.stdin.isTTY) : null;
  let configuredBridge: ReturnType<typeof buildInteractionBridge> | undefined;
  if (interactionChain) {
    try {
      configuredBridge = buildInteractionBridge(interactionChain, {
        featureName: options.feature,
        stage: "pre-flight",
      });
    } catch {}
  }
  const interactionBridge = configuredBridge ?? deps.createInteractionBridge();

  await deps.mkdirp(outputDir);

  return {
    workdir,
    naxDir,
    outputDir,
    outputPath,
    specContent,
    codebaseContext,
    normalizedRoots,
    relativePackages,
    packageDetails,
    projectName,
    branchName,
    timeoutSeconds,
    config,
    profileName,
    options,
    runtime,
    interactionChain,
    interactionBridge,
    deps,
  };
}
