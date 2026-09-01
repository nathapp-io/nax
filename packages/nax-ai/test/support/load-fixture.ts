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
  const allowed = new Set<string>(HEADER_ALLOWLIST);
  for (const key of Object.keys(parsed.response.headers)) {
    if (!allowed.has(key.toLowerCase())) {
      throw new Error(`Fixture "${name}" carries header "${key}" outside the allowlist.`);
    }
  }
  return parsed;
}
