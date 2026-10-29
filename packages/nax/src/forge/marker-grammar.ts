/** Leaf marker grammar shared by ownership helpers and forge readers. */
export const TOP_LEVEL_MARKER_KEYS = ["summary", "w-index", "w-evidence", "fix-summary"] as const;

const MARKER_KEY_PATTERN = "[A-Za-z0-9._:-]{1,128}";
export const markerPattern = (): RegExp => new RegExp(`<!-- nax-bot:v1 key=(${MARKER_KEY_PATTERN}) -->`, "g");
const MARKER_KEY = new RegExp(`^${MARKER_KEY_PATTERN}$`);

export function isNaxBotMarkerKey(key: string): boolean {
  return MARKER_KEY.exec(key)?.[0] === key;
}

/** Return the last valid v1 marker; a marker alone does not establish ownership. */
export function parseNaxBotMarker(body: string): { key: string } | null {
  const pattern = markerPattern();
  let result: { key: string } | null = null;
  for (const match of body.matchAll(pattern)) {
    const key = match[1];
    if (key !== undefined) result = { key };
  }
  return result;
}
