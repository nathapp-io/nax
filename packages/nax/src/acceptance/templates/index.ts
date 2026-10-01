/**
 * Acceptance Test Template Builders
 *
 * One builder per test strategy. The generator selects the appropriate
 * builder based on the testStrategy option.
 */

export type { CliTemplateOptions } from "./cli";
export { buildCliTemplate } from "./cli";
export type { ComponentTemplateOptions } from "./component";
export { buildComponentTemplate } from "./component";
export type { E2eTemplateOptions } from "./e2e";
export { buildE2eTemplate } from "./e2e";
export type { SnapshotTemplateOptions } from "./snapshot";
export { buildSnapshotTemplate } from "./snapshot";
export type { UnitTemplateOptions } from "./unit";
export { buildUnitTemplate } from "./unit";
