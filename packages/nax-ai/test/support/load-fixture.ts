import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { HEADER_ALLOWLIST, type RecordedFixture } from "./fixture-types.ts";

const DIR = join(import.meta.dirname, "..", "fixtures", "recorded");

export function fixtureNames(): string[] {
  return readdirSync(DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""))
    .sort();
}

export function loadFixture(name: string): RecordedFixture {
  const parsed = JSON.parse(readFileSync(join(DIR, `${name}.json`), "utf8")) as RecordedFixture;

  // A fixture predating the current recorder parses as JSON but has no
  // `response`, and would otherwise fail deep inside the header check as an
  // opaque TypeError. Name the file and the expected shape instead: the dir is
  // written by the live recorder, so the reader is usually looking at a stale
  // artifact rather than a bug.
  if (!parsed.meta || !parsed.response || !parsed.events) {
    throw new Error(
      `Fixture "${name}" is not in the current format: a fixture carries meta, response and events. ` +
        "Re-record it, or delete it if it predates the current recorder.",
    );
  }

  const allowed = new Set<string>(HEADER_ALLOWLIST);
  for (const key of Object.keys(parsed.response.headers)) {
    if (!allowed.has(key.toLowerCase())) {
      throw new Error(`Fixture "${name}" carries header "${key}" outside the allowlist.`);
    }
  }
  return parsed;
}
