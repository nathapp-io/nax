/**
 * Validates user-supplied feature names that become directory segments.
 */
import { NaxError } from "../errors";

export function validateFeatureName(feature: string): void {
  if (!feature || feature.trim() === "") {
    throw featureNameError("Feature name must be non-empty", feature);
  }

  if (feature.includes("/") || feature.includes("\\")) {
    throw featureNameError(`Feature name must be a single path segment: ${feature}`, feature);
  }

  if (feature.includes("..")) {
    throw featureNameError(`Feature name cannot contain '..': ${feature}`, feature);
  }

  const validPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
  if (!validPattern.test(feature)) {
    throw featureNameError(`Feature name contains invalid characters: ${feature}`, feature);
  }
}

function featureNameError(message: string, feature: string): NaxError {
  return new NaxError(message, "FEATURE_NAME_INVALID", { stage: "feature-name", feature });
}
