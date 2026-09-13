import type { AskResolver } from "./types";

/**
 * Why a headless run refuses an ask-matched call. Distinct from an ordinary
 * denial on purpose: the command is not forbidden, it is unapprovable HERE
 * (spec US-007). The ledger outcome `denied:ask` is how demand for the
 * interactive channel is measured before anyone builds it.
 */
export const ASK_UNAVAILABLE_REASON =
  "matched an ask rule requiring human approval; this run is headless, so approval is unavailable and the call is refused";

/** The only v1 resolver: always deny (spec R1 — ask resolves to deny headless). */
export function headlessAskResolver(): AskResolver {
  return {
    resolve() {
      return Promise.resolve("deny");
    },
  };
}
