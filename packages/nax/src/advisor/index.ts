/** A1 advisor — public surface. */

export { AdvisorHeadsUpQueue } from "../runtime/advisor-heads-up-queue";
export {
  _auditDeps,
  type AdviceAuditRecord,
  type AdviceLabel,
  adviceAuditDir,
  appendLabel,
  captureWorktreePatch,
  PATCH_CAP_BYTES,
  readAdviceAudit,
  readLabels,
  writeAdviceAudit,
} from "./audit";
export { formatHeadsUp, type HeadsUpChannel } from "./heads-up";
export {
  _ledgerDeps,
  appendDecision,
  countStoryRulings,
  type DecisionDraft,
  findReusable,
  ledgerPath,
  readDecisions,
} from "./ledger";
export { buildMenu, forcedConfirm, REQUIRED_TEXT_FIELD, toAction } from "./menus";
export {
  _advisorServiceDeps,
  type Advisor,
  type AdvisorCallContext,
  createAdvisor,
  type QuestionDraft,
} from "./service";
export type * from "./types";
