/**
 * The native LLM path: nax's own client, in-process, over @nathapp/nax-ai.
 *
 * This directory is the only place in src/ permitted to import nax-ai
 * (scripts/check-nax-ai-imports.ts). Everything outside it consumes the
 * AgentAdapter interface, so the wire library stays replaceable.
 *
 * The barrel re-exports only; it owns no values. NATIVE_AGENT lives in
 * models.ts (a leaf) so adapter.ts can import it without a cycle back through
 * this file — `check:import-cycles` runs against a baseline and a new cycle
 * fails it.
 */

export {};
