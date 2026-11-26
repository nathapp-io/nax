/** Durable chain rulings: the comment grammar the advisor's fix, waived and held outcomes are posted in. */
import { NAX_BOT_HEADER } from "../forge/marker";
import { markerPattern } from "../forge/marker-grammar";
import { safeText } from "./render";

export type ChainOutcome = "fix" | "waived" | "held";

export interface ChainRuling {
  /** The finding's own key, `f-…`. */
  readonly key: string;
  readonly outcome: ChainOutcome;
  /** fix: the instruction. waived: the reason. held: why a human must decide. */
  readonly text: string;
  /** held only: what the advisor proposed before the forced-confirm rule held it. */
  readonly proposed?: { readonly outcome: "fix" | "waived"; readonly text: string };
}

/** The cap on `text` and on `proposed.text` in a rendered comment. */
export const CHAIN_RULING_TEXT_CHARS = 1200;

const RULING_PREFIX = "Advisor ruling — ";
const PROPOSED_PREFIX = "Advisor proposed — ";
const WAIVED_FOOTER = "To change it, reply on this thread.";
const HELD_FOOTER = "Reply `confirm` to have nax fix it as reported, or `waive: <reason>` to close it.";
const FINDING_PREFIX = "f-";

/** `cr-` plus the finding key without its `f-` prefix. */
export function chainRulingKey(findingKey: string): string {
  const bare = findingKey.startsWith(FINDING_PREFIX) ? findingKey.slice(FINDING_PREFIX.length) : findingKey;
  return `cr-${bare}`;
}

function oneLine(text: string): string {
  return safeText(text.replace(/\s*[\r\n]\s*/g, " "), CHAIN_RULING_TEXT_CHARS);
}

/** The comment body, without the nax bot header and marker. */
export function renderChainRuling(ruling: ChainRuling): string {
  const head = `${RULING_PREFIX}${ruling.outcome}: ${oneLine(ruling.text)}`;
  if (ruling.outcome === "fix") return head;
  if (ruling.outcome === "waived") return `${head}\n${WAIVED_FOOTER}`;
  const proposed = ruling.proposed
    ? [`${PROPOSED_PREFIX}${ruling.proposed.outcome}: ${oneLine(ruling.proposed.text)}`]
    : [];
  return [head, ...proposed, HELD_FOOTER].join("\n");
}

function isMarkerLine(line: string): boolean {
  return line.includes("<!--") && line.replace(markerPattern(), "").trim() === "";
}

function readOutcome(line: string): ChainOutcome | null {
  for (const outcome of ["fix", "waived", "held"] as const) {
    if (line.startsWith(`${RULING_PREFIX}${outcome}: `)) return outcome;
  }
  return null;
}

function readProposed(line: string | undefined): ChainRuling["proposed"] | null {
  if (line === undefined) return null;
  for (const outcome of ["fix", "waived"] as const) {
    const prefix = `${PROPOSED_PREFIX}${outcome}: `;
    if (line.startsWith(prefix)) return { outcome, text: line.slice(prefix.length) };
  }
  return null;
}

/** Reads a body back, wrapped by `withNaxBotMarker` or bare; `null` for any other text. */
export function parseChainRuling(body: string): Omit<ChainRuling, "key"> | null {
  const kept = body.split(/\r?\n/).filter((l) => l !== "" && l !== NAX_BOT_HEADER && !isMarkerLine(l));
  const first = kept[0];
  if (first === undefined) return null;
  const outcome = readOutcome(first);
  if (outcome === null) return null;
  const text = first.slice(`${RULING_PREFIX}${outcome}: `.length);
  const proposed = outcome === "held" ? readProposed(kept[1]) : null;
  return proposed ? { outcome, text, proposed } : { outcome, text };
}

/** Finding key to instruction, for the `fix` entries of `env.chainRulings`; empty when there are none. */
export function chainInstructions(env: {
  readonly chainRulings?: readonly ChainRuling[];
}): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (const ruling of env.chainRulings ?? []) if (ruling.outcome === "fix") map.set(ruling.key, ruling.text);
  return map;
}
