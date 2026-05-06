/**
 * Bun test preload — runs once before any test file in this process.
 *
 * Redirects global nax state into a temp directory so tests never write to the
 * real ~/.nax, while still starting from a deterministic clean environment.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const isolatedGlobalDir = mkdtempSync(join(tmpdir(), "nax-test-global-"));

process.env.NAX_GLOBAL_CONFIG_DIR = isolatedGlobalDir;
delete process.env.NAX_RUNS_DIR;
