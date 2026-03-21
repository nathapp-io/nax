/**
 * deps.ts — Injectable deps save/restore helpers for bun:test.
 *
 * Eliminates the boilerplate of manually declaring `let original*` variables
 * and wiring up `beforeEach`/`afterEach` restore logic in every test file.
 *
 * Usage:
 *
 * ```ts
 * import { withDepsRestore } from "../../helpers/deps";
 *
 * describe("my module", () => {
 *   // Save specific keys — restored after every test
 *   withDepsRestore(_cleanupDeps, ["spawn", "sleep", "kill"]);
 *
 *   // Or save ALL keys of a deps object
 *   withDepsRestore(_cleanupDeps);
 * });
 * ```
 *
 * The helper registers `beforeEach` (save) and `afterEach` (restore) inside
 * the enclosing `describe` block, so it scopes naturally to that block.
 */

/**
 * Save and restore injectable deps around each test in the enclosing describe.
 *
 * @param deps  - The deps object exported from the module under test.
 * @param keys  - Keys to save/restore. Omit to save all enumerable keys.
 */
export function withDepsRestore<T extends Record<string, unknown>>(deps: T, keys?: (keyof T)[]): void {
	const saved: Partial<T> = {};

	beforeEach(() => {
		const keysToSave = keys ?? (Object.keys(deps) as (keyof T)[]);
		for (const key of keysToSave) {
			saved[key] = deps[key];
		}
	});

	afterEach(() => {
		for (const key of Object.keys(saved) as (keyof T)[]) {
			deps[key] = saved[key] as T[keyof T];
			delete saved[key];
		}
	});
}
