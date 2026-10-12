/**
 * Provider of a resolved model id, for provider-scoped cooldown keys.
 *
 * `resolveModel` stamps provider `"unknown"` on literal pins it does not recognise,
 * so a pin like `minimax/MiniMax-M3` resolves to `unknown/minimax/MiniMax-M3` while the
 * same model reached through a tier reads `minimax/minimax/MiniMax-M3` (or the bare
 * pin when a caller passes it unresolved). The provider is the first path segment
 * that is not `"unknown"`, and it must be followed by a model segment: `unknown/sonnet`
 * names no provider at all (claude), so the cooldown degrades to agent-wide.
 */
export function providerOf(modelId?: string): string | undefined {
  if (!modelId) return undefined;
  const segments = modelId.split("/");
  const start = segments.findIndex((s) => s !== "unknown");
  if (start < 0 || start >= segments.length - 1) return undefined;
  return segments[start] || undefined;
}
