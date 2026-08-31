import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ProtocolEvent } from "../../../src/protocols/types.ts";

const DIR = join(import.meta.dirname, "..", "..", "fixtures", "recorded");

/**
 * Writes a live run's event sequence to disk so M3 can build its fixture suite
 * from real provider output rather than from scripted guesses.
 */
export function record(name: string, events: readonly ProtocolEvent[]): void {
  const file = join(DIR, `${name}.json`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(events, null, 2)}\n`, "utf8");
}
