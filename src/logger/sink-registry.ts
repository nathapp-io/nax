import type { LogEntry } from "./types.js";
import type { LogSink } from "./types.js";

/**
 * Fan-out dispatch for redacted log entries to a list of registered sinks.
 *
 * Each sink is fault-isolated: a thrown error is swallowed and reported to
 * stderr so a misbehaving exporter cannot break later sinks, the JSONL file,
 * or the originating log call.
 */
export class SinkRegistry {
  private readonly sinks: LogSink[] = [];

  /**
   * Register a sink. Returns an unsubscribe function.
   */
  add(sink: LogSink): () => void {
    this.sinks.push(sink);
    return () => {
      const idx = this.sinks.indexOf(sink);
      if (idx !== -1) {
        this.sinks.splice(idx, 1);
      }
    };
  }

  /**
   * Dispatch a redacted entry to every registered sink in registration order.
   *
   * Each sink gets a shallow clone so one sink mutating `message`, `data`, or
   * any other field cannot leak the mutation to later sinks or to the JSONL
   * file written after dispatch. Without this, a buggy sink could rewrite a
   * redacted secret back into the entry and break the redaction-by-construction
   * guarantee the Logger relies on.
   */
  dispatch(entry: LogEntry): void {
    for (const sink of this.sinks) {
      try {
        sink({ ...entry });
      } catch (error) {
        process.stderr.write(`[logger] Sink threw: ${error}\n`);
      }
    }
  }
}
