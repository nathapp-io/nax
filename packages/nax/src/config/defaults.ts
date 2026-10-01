/**
 * Default Configuration
 *
 * The default NaxConfig used as a base for all projects.
 * Derived from NaxConfigSchema.parse({}) — Zod defaults are the authoritative source.
 */

import { NaxConfigSchema } from "./schemas";
import type { NaxConfig } from "./types";

export const DEFAULT_CONFIG = NaxConfigSchema.parse({}) as NaxConfig;
