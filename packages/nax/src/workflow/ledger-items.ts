/** What the story loops left for the branch review (spec §7 step 2): deferred minors, cannot-verify items, parked rulings. */
import { FEATURE_SCOPE } from "./advisor-live";
import { ledgerFilePath } from "./ledger";
import { runDirsNewestFirst } from "./result";

export interface LedgerItem {
  readonly storyId: string;
  readonly text: string;
}

export interface LedgerItems {
  readonly deferredMinors: readonly LedgerItem[];
  readonly cannotVerify: readonly LedgerItem[];
  readonly parked: readonly LedgerItem[];
}

type Kind = keyof LedgerItems;

const LINE = /^(\S+): (deferred-minor|cannot-verify|Ruling): (.+)$/;
const KIND: Readonly<Record<string, Kind>> = {
  "deferred-minor": "deferredMinors",
  "cannot-verify": "cannotVerify",
  Ruling: "parked",
};
const PREFLIGHT_RULING = /^pre-flight /;

function parseLine(line: string): { kind: Kind; item: LedgerItem } | null {
  const m = LINE.exec(line);
  if (!m || m[1] === FEATURE_SCOPE) return null;
  const kind = KIND[m[2] ?? ""];
  const text = (m[3] ?? "").trim();
  if (!kind || text === "" || (kind === "parked" && PREFLIGHT_RULING.test(text))) return null;
  return { kind, item: { storyId: m[1] ?? "", text } };
}

/** Every run's ledger, oldest run first; identical lines from a resumed story count once. */
export async function collectLedgerItems(featureDir: string): Promise<LedgerItems> {
  const out: Record<Kind, LedgerItem[]> = { deferredMinors: [], cannotVerify: [], parked: [] };
  const seen = new Set<string>();
  for (const runDir of [...(await runDirsNewestFirst(featureDir))].reverse()) {
    const file = Bun.file(ledgerFilePath(runDir));
    if (!(await file.exists())) continue;
    for (const line of (await file.text()).split("\n")) {
      const parsed = parseLine(line);
      const key = parsed ? `${parsed.kind}|${parsed.item.storyId}|${parsed.item.text}` : "";
      if (!parsed || seen.has(key)) continue;
      seen.add(key);
      out[parsed.kind] = [...out[parsed.kind], parsed.item];
    }
  }
  return out;
}
