import type { ReporterEvent, WebhookReporterConfig } from "@/config/schemas-reporters";
import { getSafeLogger } from "@/logger";
import type { IReporter, NaxPlugin } from "@/plugins/types";
import { interpolateHeaders, type PostJsonDeps, postJson } from "../reporter-shared";

const STAGE = "webhook-reporter";

/**
 * Built-in reporter that POSTs a JSON envelope per run/story event to a
 * configured webhook URL. Stateless and fire-and-forget.
 *
 * @param cfg  - resolved webhook reporter config (closed over by the reporter)
 * @param deps - injectable fetch deps (tests only)
 */
export function createWebhookReporterPlugin(cfg: WebhookReporterConfig, deps?: PostJsonDeps): NaxPlugin {
  const enabledEvent = (event: ReporterEvent): boolean => cfg.events === undefined || cfg.events.includes(event);

  const emit = async (type: ReporterEvent, data: unknown): Promise<void> => {
    if (!cfg.url || !enabledEvent(type)) return;
    const { resolved, missing } = interpolateHeaders(cfg.headers);
    if (missing.length > 0) {
      getSafeLogger()?.warn(STAGE, "Skipping webhook — unresolved env vars", { missing });
      return;
    }
    await postJson(
      cfg.url,
      { type, emittedAt: new Date().toISOString(), data },
      { headers: resolved, timeoutMs: cfg.timeoutMs, stage: STAGE, deps },
    );
  };

  const reporter: IReporter = {
    name: STAGE,
    onRunStart: (event) => emit("onRunStart", event),
    onStoryComplete: (event) => emit("onStoryComplete", event),
    onRunEnd: (event) => emit("onRunEnd", event),
    onPhaseStart: (event) => emit("onPhaseStart", event),
    onPhaseComplete: (event) => emit("onPhaseComplete", event),
  };

  return {
    name: STAGE,
    version: "1.0.0",
    provides: ["reporter"],
    extensions: { reporter },
  };
}
