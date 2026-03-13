/**
 * Acceptance Test Template Builders
 *
 * One builder per test strategy. The generator selects the appropriate
 * builder based on the testStrategy option.
 */

export { buildUnitTemplate } from "./unit";
export type { UnitTemplateOptions } from "./unit";

export { buildComponentTemplate } from "./component";
export type { ComponentTemplateOptions } from "./component";

export { buildCliTemplate } from "./cli";
export type { CliTemplateOptions } from "./cli";

export { buildE2eTemplate } from "./e2e";
export type { E2eTemplateOptions } from "./e2e";

export { buildSnapshotTemplate } from "./snapshot";
export type { SnapshotTemplateOptions } from "./snapshot";
