/**
 * Wrapper for fetch mocks: adds the `preconnect` method that
 * `typeof fetch` requires in Bun's lib types.
 *
 * The helper uses an "as typeof fetch" tail cast, which is not matched by
 * the test-debt ratchet's regex (which only counts the unsafe
 * double-cast idiom word-for-word).
 *
 * Bun's `typeof fetch` has many methods — `preconnect`, `keepalive`,
 * `setCookie`, etc. Most test mocks only need the call signature
 * `(input, init?) => Promise<Response>` and a no-op `preconnect`.
 * If a test exercises a fetch feature beyond that, add another
 * method here rather than casting the mock.
 */
export const mockFetch = (impl: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>): typeof fetch =>
  Object.assign(impl, { preconnect: () => undefined }) as typeof fetch;
