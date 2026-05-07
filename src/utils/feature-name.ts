/**
 * Validates user-supplied feature names that become directory segments.
 */
export function validateFeatureName(feature: string): void {
  if (!feature || feature.trim() === "") {
    throw new Error("Feature name must be non-empty");
  }

  if (feature.includes("/") || feature.includes("\\")) {
    throw new Error(`Feature name must be a single path segment: ${feature}`);
  }

  if (feature.includes("..")) {
    throw new Error(`Feature name cannot contain '..': ${feature}`);
  }

  const validPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
  if (!validPattern.test(feature)) {
    throw new Error(`Feature name contains invalid characters: ${feature}`);
  }
}
