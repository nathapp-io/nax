/**
 * Auto-Route Calibration Type Definitions
 *
 * Auto-route configuration interfaces extracted from runtime-types.ts
 * to keep each file within the 600-line project limit.
 */

/** Auto route calibration thresholds (US-001) */
export interface AutoRouteUpgradeConfig {
  escalationRate: number;
  mismatchRate: number;
}

export interface AutoRouteDowngradeConfig {
  firstPassRate: number;
  escalationRate: number;
}

export interface AutoRouteConfig {
  enabled: boolean;
  minSamples: number;
  upgrade: AutoRouteUpgradeConfig;
  downgrade: AutoRouteDowngradeConfig;
}
