/**
 * Finish A: `finish.timeouts.stepMs` became `reviewMs` and `fixMs`. A benign rename
 * (config-patterns.md): a numeric `stepMs` fills whichever of the two is unset, then
 * is removed. Runs per config layer before the Zod parse, which would otherwise strip
 * the key silently. Returns a new object; never mutates.
 */
export function _applyFinishStepTimeoutShim(
  conf: Record<string, unknown>,
  warn: (msg: string) => void,
): Record<string, unknown> {
  const finish = conf.finish as Record<string, unknown> | undefined;
  const timeouts = finish?.timeouts as Record<string, unknown> | undefined;
  if (!timeouts || !("stepMs" in timeouts)) return conf;
  const { stepMs, ...rest } = timeouts;
  if (typeof stepMs !== "number") return { ...conf, finish: { ...finish, timeouts: rest } };
  warn(
    "finish.timeouts.stepMs is deprecated: it now sets finish.timeouts.reviewMs and finish.timeouts.fixMs where those are unset. Set those two keys instead.",
  );
  return {
    ...conf,
    finish: { ...finish, timeouts: { ...rest, reviewMs: rest.reviewMs ?? stepMs, fixMs: rest.fixMs ?? stepMs } },
  };
}
