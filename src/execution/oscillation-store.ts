export function recordOscillations(store: Map<string, number>, storyId: string, delta: number): number {
  if (!Number.isSafeInteger(delta) || delta < 1) {
    throw new RangeError("[execution] oscillation delta must be a positive safe integer");
  }
  const total = (store.get(storyId) ?? 0) + delta;
  store.set(storyId, total);
  return total;
}

export function getOscillations(store: Map<string, number>, storyId: string): number {
  return store.get(storyId) ?? 0;
}
