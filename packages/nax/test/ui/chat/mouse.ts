import type { MouseEvent, MouseEvents } from "@/tui/chat/mouse-input";

/** A synchronous mouse source, with subscription ownership observable in mounted tests. */
export function fakeMouse() {
  const listeners = new Set<(event: MouseEvent) => void>();
  const events: MouseEvents = {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return {
    events,
    listeners,
    emit(kind: MouseEvent["kind"], point: Partial<Omit<MouseEvent, "kind">> = {}) {
      for (const listener of listeners) listener({ kind, button: "none", x: 1, y: 1, ...point });
    },
  };
}
