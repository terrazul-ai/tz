import path from 'node:path';

import { describe, it, expect } from 'vitest';

import { resolveProjectRoot } from '../../../src/core/extract/sanitize';

describe('resolveProjectRoot', () => {
  it('returns parent for known tool subdirs', () => {
    const base = path.join('/tmp', 'proj');
    expect(resolveProjectRoot(path.join(base, '.claude'))).toBe(base);
    expect(resolveProjectRoot(path.join(base, '.codex'))).toBe(base);
    expect(resolveProjectRoot(path.join(base, '.gemini'))).toBe(base);
  });

  it('returns given path otherwise', () => {
    const p = path.join('/tmp', 'proj', 'nested');
    expect(resolveProjectRoot(p)).toBe(p);
  });
});
