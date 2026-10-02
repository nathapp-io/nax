/**
 * Builds the per-story shadow from config (spec 4.5, 5).
 *
 * The config parameter is typed structurally so this module imports nothing
 * from src/config (D8). Returns undefined when no URL is configured, so no
 * shadow code runs on the call path by default.
 *
 * US-003: when the config also carries a `guard`, the shadow exposes a
 * `CommandGuard` whose `assess` reuses this shadow's classifier cache and
 * rule baseline. Absent guard = `shadow.guard === undefined`, the safe
 * default that no shipped profile opts into.
 */
import { join } from "node:path";
import { errorMessage } from "#src/infra/errors";
import { getSafeLogger } from "#src/infra/index";
import { appendCommandSafetyRow } from "./row";
import { createCommandShadow } from "./shadow";
import { createSystemOneClient } from "./systemone-client";
import type { CommandShadow } from "./types";

export const COMMAND_SAFETY_DIR = "command-safety";

export interface BuildCommandShadowOptions {
  readonly config:
    | {
        readonly shadow?: { readonly url: string; readonly timeoutMs: number; readonly authEnv: string };
        readonly guard?: { readonly threshold: number };
      }
    | undefined;
  readonly outputDir: string;
  readonly runId: string;
  readonly storyId?: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

export function buildCommandShadow(opts: BuildCommandShadowOptions): CommandShadow | undefined {
  const shadow = opts.config?.shadow;
  if (shadow === undefined) return undefined;
  const token = opts.env[shadow.authEnv];
  const dir = join(opts.outputDir, COMMAND_SAFETY_DIR);
  let warned = false;
  return createCommandShadow({
    classify: createSystemOneClient({
      url: shadow.url,
      timeoutMs: shadow.timeoutMs,
      ...(token !== undefined && token.length > 0 ? { token } : {}),
    }),
    write: (row) => appendCommandSafetyRow(dir, opts.runId, row),
    runId: opts.runId,
    timeoutMs: shadow.timeoutMs,
    ...(opts.config?.guard !== undefined ? { guard: opts.config.guard } : {}),
    onWriteError: (err) => {
      if (warned) return;
      warned = true;
      getSafeLogger()?.warn("command-safety", "Shadow row append failed; later failures this story are not logged", {
        storyId: opts.storyId,
        error: errorMessage(err),
      });
    },
  });
}
