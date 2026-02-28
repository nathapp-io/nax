/**
 * Status CLI Command
 *
 * Re-export barrel for backward compatibility.
 * Cost metrics: ./status-cost
 * Feature display: ./status-features
 */

// Cost metrics
export { displayCostMetrics, displayLastRunMetrics, displayModelEfficiency } from "./status-cost";

// Feature display
export { displayFeatureStatus, type FeatureStatusOptions } from "./status-features";
