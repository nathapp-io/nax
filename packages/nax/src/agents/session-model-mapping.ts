/**
 * nax's one mapping from a config `ModelDef` to the contract's `SessionModel`
 * (S1 spec section 4.2, port 2). Called where nax opens a session
 * (`session/model-selection.ts`) and where the native shell makes a one-shot
 * call (`agents/native-agent`). Config pricing is converted here and nowhere
 * else on those paths. Absent fields stay absent rather than `undefined`, so a
 * missing override still means "use the catalog".
 */

import type { SessionModel } from "@nathapp/nax-agent";
import type { ModelDef } from "../config/schema-types";
import { toPricing } from "../config/schema-types";

export function toSessionModel(def: ModelDef): SessionModel {
  return {
    provider: def.provider,
    model: def.model,
    ...(def.pricing !== undefined ? { pricing: toPricing(def.pricing) } : {}),
    ...(def.contextWindow !== undefined ? { contextWindow: def.contextWindow } : {}),
    ...(def.env !== undefined ? { env: def.env } : {}),
  };
}
