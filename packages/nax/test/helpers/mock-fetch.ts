/**
 * Wrapper for fetch mocks: adds the `preconnect` method that
 * `typeof fetch` requires in Bun's lib types.
 *
 * Bun's `typeof fetch` is a callable carrying a `preconnect` member, so a bare
 * `mock(async (url, init) => …)` is not assignable to it. Borrowing the real
 * `preconnect` off `globalThis.fetch` satisfies the type exactly — no cast, and
 * no invented behaviour for a method nothing under test calls.
 *
 * If a test exercises a fetch feature beyond the call signature, add the member
 * here rather than casting the mock at the call site.
 */
export const mockFetch = (impl: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>): typeof fetch =>
  Object.assign(impl, { preconnect: globalThis.fetch.preconnect });
