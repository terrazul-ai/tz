export interface ParsedPackageSpec {
  name: string;
  range: string;
}

/**
 * Parse a package specification string into name and version range.
 * Supports both scoped (@scope/name@version) and unscoped (name@version) formats.
 *
 * @param spec - Package spec like @scope/name@1.0.0 or name@^1.0.0
 * @returns Parsed name and range, or null if invalid format
 *
 * @example
 * parsePackageSpec('@terrazul/starter@^1.0.0')
 * // Returns: { name: '@terrazul/starter', range: '^1.0.0' }
 */
export function parsePackageSpec(spec?: string): ParsedPackageSpec | null {
  if (!spec) return null;

  // Try matching with explicit version first: @scope/name@version or name@version
  const scopedMatch = spec.match(/^(@[^@]+?)@([^@]+)$/);
  const unscopedMatch = spec.match(/^([^@]+)@([^@]+)$/);
  const match = scopedMatch || unscopedMatch;

  if (match) {
    return { name: match[1], range: match[2] };
  }

  // Fallback: name without version — scoped (@scope/name) or unscoped (name)
  const scopedNameOnly = spec.match(/^@[^/]+\/[^/@]+$/);
  if (scopedNameOnly) {
    return { name: spec, range: '*' };
  }

  const unscopedNameOnly = spec.match(/^[\dA-Za-z][\w.-]*$/);
  if (unscopedNameOnly) {
    return { name: spec, range: '*' };
  }

  return null;
}
