import { describe, expect, it } from 'vitest';

import { parsePackageSpec } from '../../../src/utils/package-spec.js';

describe('parsePackageSpec', () => {
  it('returns null for undefined input', () => {
    expect(parsePackageSpec()).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parsePackageSpec('')).toBeNull();
  });

  it('parses scoped package with version', () => {
    expect(parsePackageSpec('@scope/name@1.0.0')).toEqual({
      name: '@scope/name',
      range: '1.0.0',
    });
  });

  it('parses scoped package with semver range', () => {
    expect(parsePackageSpec('@terrazul/starter@^1.0.0')).toEqual({
      name: '@terrazul/starter',
      range: '^1.0.0',
    });
  });

  it('parses unscoped package with version', () => {
    expect(parsePackageSpec('my-pkg@2.0.0')).toEqual({
      name: 'my-pkg',
      range: '2.0.0',
    });
  });

  it('parses scoped package name without version as wildcard range', () => {
    expect(parsePackageSpec('@scope/name')).toEqual({
      name: '@scope/name',
      range: '*',
    });
  });

  it('parses unscoped package name without version as wildcard range', () => {
    expect(parsePackageSpec('simple-name')).toEqual({
      name: 'simple-name',
      range: '*',
    });
  });

  it('parses scoped package with nested scope', () => {
    expect(parsePackageSpec('@terrazul/starter')).toEqual({
      name: '@terrazul/starter',
      range: '*',
    });
  });

  it('returns null for bare @ symbol', () => {
    expect(parsePackageSpec('@')).toBeNull();
  });

  it('returns null for scope without name', () => {
    expect(parsePackageSpec('@scope/')).toBeNull();
  });

  it('returns null for scope missing slash', () => {
    expect(parsePackageSpec('@scope')).toBeNull();
  });
});
