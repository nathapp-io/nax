import { join } from "node:path";
import { buildPackageSummary, buildSourceRootsSection } from "../../cli/plan-helpers";
import { DEFAULT_TIMEOUT_SECONDS, createPlanRuntime, detectProjectName } from "../../cli/plan-runtime";
import type { NaxConfig } from "../../config";
import { planConfigSelector } from "../../config/selectors";
import type { PlanCommandOptions, PlanDeps, PlanModeContext } from "./types";

export async function buildPlanModeContext(
  workdir: string,
  fullConfig: NaxConfig,
  options: PlanCommandOptions,
  deps: PlanDeps,
): Promise<PlanModeContext> {
  const naxDir = join(workdir, ".nax");
  const outputDir = join(naxDir, "features", options.feature);
  const outputPath = join(outputDir, "prd.json");

  const [specContent, sourceRoots, pkg] = await Promise.all([
    deps.readFile(options.from).catch(() => ""),
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
  const runtime = createPlanRuntime(fullConfig, workdir, options.feature);
  const interactionChain = fullConfig ? await deps.initInteractionChain(fullConfig, !process.stdin.isTTY) : null;
  const interactionBridge = deps.createInteractionBridge();

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
    fullConfig,
    options,
    runtime,
    interactionChain,
    interactionBridge,
    deps,
  };
}
