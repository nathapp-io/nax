/**
 * Type-level contract: _rollbackDeps.spawn must match Bun.spawn signature.
 * Ensures the injectable dep shape stays compatible with the Bun runtime.
 */
import { _rollbackDeps } from "@/tdd/rollback";

type SpawnType = typeof Bun.spawn;
const _check: SpawnType = _rollbackDeps.spawn;
void _check;
