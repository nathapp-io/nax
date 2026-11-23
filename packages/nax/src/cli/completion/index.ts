/**
 * Shell completion — public surface of `src/cli/completion/`.
 *
 * Files in this directory import each other relatively and reach config through
 * the `@/config` barrel; none of them imports `@/cli`, which re-exports this
 * barrel and would close an import cycle.
 */

export { type CompletionSources, completeWords } from "./engine";
export {
  _completionCliDeps,
  type CompletionCliDeps,
  registerCompletionCommand,
} from "./register";
export { type CompletionShell, completionScript, SUPPORTED_SHELLS } from "./scripts";
export { listFeatureNames, listProfileNames } from "./values";
