/**
 * Re-export of nax's own `package.json` for module-internal use.
 *
 * Lives at `src/_pkg.ts` so the literal `../package.json` import resolves
 * at exactly one level up (legal under biome's `noRestrictedImports`,
 * which bans `../../*` and `../../**` patterns), without forcing consumer
 * modules to deep-relatives into `src/agents/catalog/` or wherever the
 * catalog happens to live.
 */

import pkg from "../package.json";
export default pkg;
