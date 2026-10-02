/**
 * Side-effect module: installs nax's Bun runtime into nax-agent's runtime slot.
 * Imported FIRST by bin/nax.ts and test/preload.ts, so every nax path (including
 * ones that never call initLogger, such as --help) and every nax test runs it.
 * Never reset.
 */
import { setAgentRuntime } from "@nathapp/nax-agent";
import { bunAgentRuntime } from "./bun-runtime";

setAgentRuntime(bunAgentRuntime);
