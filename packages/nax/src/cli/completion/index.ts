/**
 * Shell completion — public surface of `src/cli/completion/`.
 *
 * Files in this directory import each other relatively and reach config through
 * the `@/config` barrel; none of them imports `@/cli`, which re-exports this
 * barrel and would close an import cycle.
 */

export { listFeatureNames, listProfileNames } from "./values";
