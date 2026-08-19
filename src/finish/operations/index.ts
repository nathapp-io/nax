/**
 * Barrel for `src/finish/operations/` — the `RunOperation`s finish's machine
 * dispatches through `callOp`.
 */
export { finishFixOp } from "./fix-op";
export type { FinishFixInput } from "./fix-op";
export { finishReviewOp } from "./review-op";
export type { FinishReviewInput, FinishReviewOutput } from "./review-op";
