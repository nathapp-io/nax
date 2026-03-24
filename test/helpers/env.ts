/**
 * Environment-based test helpers.
 *
 * By default, environment-sensitive tests (requiring real Claude binary,
 * live PIDs, file permission tricks, or heavy integration) are skipped.
 *
 * Set FULL=1 to run everything:
 *   FULL=1 bun test test/
 */

import { describe, test } from "bun:test";

/** Use instead of `test` for environment-sensitive tests. Skips unless FULL=1. */
export const fullTest = process.env.FULL === "1" ? test : test.skip;

/** Use instead of `describe` for environment-sensitive describe blocks. Skips unless FULL=1. */
export const fullDescribe = process.env.FULL === "1" ? describe : describe.skip;
