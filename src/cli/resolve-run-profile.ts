import { listProfiles } from "../config";
import { getSafeLogger } from "../logger";

/**
 * Delta C4 run-side: resolve the config-profile override for `nax run`.
 *
 * Precedence: CLI --profile > NAX_PROFILE env (handled inside loadConfig — we
 * return undefined so it applies) > PRD routingProfile > loadConfig defaults.
 *
 * GUARD: loadProfile THROWS on a missing profile file, so a PRD profile is
 * adopted only when it actually resolves (or is "default", which the loader
 * treats as no-overlay). Stale/legacy values warn and are skipped.
 *
 * Returns the profile name to pass as a CLI override into loadConfig, or
 * undefined to let loadConfig's own resolution run.
 */
export async function resolveRunProfileOverride(opts: {
  prdPath: string;
  projectRoot: string;
  cliProfile: string | undefined;
  envProfile: string | undefined;
  /** Test seam — defaults to reading prdPath via Bun.file */
  _readJson?: (path: string) => Promise<unknown>;
  /** Test seam — defaults to listProfiles(projectRoot) name extraction */
  _listProfileNames?: () => Promise<string[]>;
}): Promise<string | undefined> {
  if (opts.cliProfile) return opts.cliProfile;
  if (opts.envProfile) return undefined;

  const readJson =
    opts._readJson ??
    (async (path: string) => {
      const file = Bun.file(path);
      if (!(await file.exists())) return undefined;
      return file.json();
    });

  try {
    const prd = (await readJson(opts.prdPath)) as { routingProfile?: unknown } | undefined;
    if (prd && typeof prd.routingProfile === "string" && prd.routingProfile.length > 0) {
      const name = prd.routingProfile;
      if (name === "default") return name;
      const listNames =
        opts._listProfileNames ?? (async () => (await listProfiles(opts.projectRoot)).map((p) => p.name));
      const available = await listNames();
      if (available.includes(name)) return name;
      getSafeLogger()?.warn(
        "run",
        `PRD was planned with config profile "${name}" but no such profile exists — continuing with current config resolution`,
        { storyId: "prd", plannedProfile: name },
      );
    }
  } catch {
    // Corrupt/unreadable PRD — let the run's own PRD load surface the real error.
  }
  return undefined;
}
