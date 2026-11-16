/**
 * Runtime types for the `forge` config block (US-001).
 *
 * The `kind` union is spelled out rather than imported from `@/forge`: config
 * must not depend on the forge module, which reads config back through a
 * dynamic import.
 */

export interface ForgeConfig {
  /** The forge kind for this project config; absent leaves detection to decide. */
  kind?: "github" | "gitlab";
}
