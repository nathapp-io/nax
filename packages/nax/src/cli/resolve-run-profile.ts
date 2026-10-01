import { listProfiles, parseProfileList } from "../config";
import { getSafeLogger } from "../logger";

/**
 * Delta C4 run-side: resolve the config-profile override for `nax run`.
 *
 * Precedence: CLI --profile > NAX_PROFILE env (handled inside loadConfig — we
 * return undefined so it applies) > PRD routingProfile > loadConfig defaults.
 *
 * Multi-profile: CLI and PRD values accept the comma form (and the CLI also the
 * array form, from repeated flags); both resolve to an ordered chain where a
 * later profile overrides an earlier one.
 *
 * GUARD: loadProfile THROWS on a missing profile file, so a PRD chain is adopted
 * only when EVERY non-"default" name resolves. If any is missing, the whole PRD
 * chain is skipped (warn) and config resolution falls through.
 *
 * Returns the profile chain to pass as a CLI override into loadConfig, or
 * undefined to let loadConfig's own resolution run.
 */
export async function resolveRunProfileOverride(opts: {
  prdPath: string;
  projectRoot: string;
  cliProfile: string | string[] | undefined;
  envProfile: string | undefined;
  /** Test seam — defaults to reading prdPath via Bun.file */
  _readJson?: (path: string) => Promise<unknown>;
  /** Test seam — defaults to listProfiles(projectRoot) name extraction */
  _listProfileNames?: () => Promise<string[]>;
}): Promise<string[] | undefined> {
  const cliChain = parseProfileList(opts.cliProfile);
  if (cliChain.length > 0) return cliChain;
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
    const rp = prd?.routingProfile;
    const prdChain = parseProfileList(
      typeof rp === "string" || Array.isArray(rp) ? (rp as string | string[]) : undefined,
    );
    if (prdChain.length > 0) {
      const listNames =
        opts._listProfileNames ?? (async () => (await listProfiles(opts.projectRoot)).map((p) => p.name));
      const available = await listNames();
      // "default" never needs a profile file; everything else must resolve.
      const missing = prdChain.filter((name) => name !== "default" && !available.includes(name));
      if (missing.length === 0) return prdChain;
      getSafeLogger()?.warn(
        "run",
        `PRD was planned with config profile(s) "${prdChain.join(",")}" but ${missing.join(", ")} not found — continuing with current config resolution`,
        { storyId: "prd", plannedProfile: prdChain.join(","), missing },
      );
    }
  } catch {
    // Corrupt/unreadable PRD — let the run's own PRD load surface the real error.
  }
  return undefined;
}
