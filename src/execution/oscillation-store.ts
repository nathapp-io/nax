export function recordOscillations(store: Map<string, number>, storyId: string, delta: number): number {
  const total = (store.get(storyId) ?? 0) + delta;
  store.set(storyId, total);
  return total;
}

export function getOscillations(store: Map<string, number>, storyId: string): number {
  return store.get(storyId) ?? 0;
}
