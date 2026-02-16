import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { interpolate } from '../../../src/utils/handlebars-runtime';

describe('handlebars-runtime helpers', () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hbs-test-'));
    await fs.mkdir(path.join(tmpDir, 'memories'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, 'test.txt'), 'test', 'utf8');
  });

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('exists helper', () => {
    it('returns true for existing directory', () => {
      const template = "{{#if (exists 'memories/')}}found{{else}}not found{{/if}}";
      const result = interpolate(template, { project: { root: tmpDir } });
      expect(result).toBe('found');
    });

    it('returns true for existing file', () => {
      const template = "{{#if (exists 'test.txt')}}found{{else}}not found{{/if}}";
      const result = interpolate(template, { project: { root: tmpDir } });
      expect(result).toBe('found');
    });

    it('returns false for non-existing path', () => {
      const template = "{{#if (exists 'nonexistent/')}}found{{else}}not found{{/if}}";
      const result = interpolate(template, { project: { root: tmpDir } });
      expect(result).toBe('not found');
    });

    it('returns false for invalid path types', () => {
      const template = '{{#if (exists invalidArg)}}found{{else}}not found{{/if}}';
      const result = interpolate(template, { project: { root: tmpDir }, invalidArg: 123 });
      expect(result).toBe('not found');
    });
  });

  describe('exists helper - security', () => {
    it('rejects absolute Unix paths', () => {
      const template = "{{#if (exists '/etc/passwd')}}found{{else}}not found{{/if}}";
      const result = interpolate(template, { project: { root: tmpDir } });
      expect(result).toBe('not found');
    });

    it('rejects absolute Windows paths', () => {
      const template = String.raw`{{#if (exists 'C:\\Windows\\System32')}}found{{else}}not found{{/if}}`;
      const result = interpolate(template, { project: { root: tmpDir } });
      expect(result).toBe('not found');
    });

    it('rejects parent directory traversal outside project root', () => {
      const template = "{{#if (exists '../../../etc/passwd')}}found{{else}}not found{{/if}}";
      const result = interpolate(template, { project: { root: tmpDir } });
      expect(result).toBe('not found');
    });

    it('rejects path attempting to escape via multiple parent traversals', () => {
      const template =
        "{{#if (exists '../../../../../../../../etc/hosts')}}found{{else}}not found{{/if}}";
      const result = interpolate(template, { project: { root: tmpDir } });
      expect(result).toBe('not found');
    });

    it('allows relative paths within project root', () => {
      const template = "{{#if (exists 'test.txt')}}found{{else}}not found{{/if}}";
      const result = interpolate(template, { project: { root: tmpDir } });
      expect(result).toBe('found');
    });

    it('allows subdirectory paths within project root', () => {
      const template = "{{#if (exists 'memories/')}}found{{else}}not found{{/if}}";
      const result = interpolate(template, { project: { root: tmpDir } });
      expect(result).toBe('found');
    });

    it('allows parent traversal within project root boundaries', async () => {
      // Create structure: tmpDir (project root)/sub1/sub2/
      const subDir = path.join(tmpDir, 'sub1', 'sub2');
      await fs.mkdir(subDir, { recursive: true });
      await fs.writeFile(path.join(tmpDir, 'sub1', 'sibling.txt'), 'test', 'utf8');

      // With project root = tmpDir, we can access sub1/sub2/../sibling.txt
      // This resolves to tmpDir/sub1/sibling.txt which is within tmpDir
      const template = "{{#if (exists 'sub1/sub2/../sibling.txt')}}found{{else}}not found{{/if}}";
      const result = interpolate(template, { project: { root: tmpDir } });
      expect(result).toBe('found');
    });

    it('rejects parent traversal that would escape even from nested directory', async () => {
      // Create nested structure: tmpDir/sub1/sub2/
      const subDir = path.join(tmpDir, 'sub1', 'sub2');
      await fs.mkdir(subDir, { recursive: true });

      // From sub2, ../../../etc/passwd tries to escape tmpDir entirely
      const template = "{{#if (exists '../../../etc/passwd')}}found{{else}}not found{{/if}}";
      const result = interpolate(template, { project: { root: subDir } });
      expect(result).toBe('not found');
    });

    it('rejects mixed absolute and relative path attempts', () => {
      const template = "{{#if (exists '/tmp/../etc/passwd')}}found{{else}}not found{{/if}}";
      const result = interpolate(template, { project: { root: tmpDir } });
      expect(result).toBe('not found');
    });

    it('handles edge case of checking project root itself', () => {
      const template = "{{#if (exists '.')}}found{{else}}not found{{/if}}";
      const result = interpolate(template, { project: { root: tmpDir } });
      expect(result).toBe('found');
    });

    it('handles edge case of checking parent of project root (should be rejected)', () => {
      const template = "{{#if (exists '..')}}found{{else}}not found{{/if}}";
      const result = interpolate(template, { project: { root: tmpDir } });
      expect(result).toBe('not found');
    });
  });

  describe('eq helper', () => {
    it('returns true for equal values', () => {
      const template = '{{#if (eq a b)}}equal{{else}}not equal{{/if}}';
      const result = interpolate(template, { a: 'test', b: 'test' });
      expect(result).toBe('equal');
    });

    it('returns false for different values', () => {
      const template = '{{#if (eq a b)}}equal{{else}}not equal{{/if}}';
      const result = interpolate(template, { a: 'test', b: 'other' });
      expect(result).toBe('not equal');
    });
  });

  describe('json helper', () => {
    it('serializes objects to JSON', () => {
      const template = '{{{json data}}}';
      const result = interpolate(template, { data: { foo: 'bar', baz: 123 } });
      expect(result).toBe('{\n  "foo": "bar",\n  "baz": 123\n}');
    });
  });

  describe('findById helper', () => {
    it('finds entry by id', () => {
      const template = '{{findById items "b" "name"}}';
      const result = interpolate(template, {
        items: [
          { id: 'a', name: 'Alice' },
          { id: 'b', name: 'Bob' },
        ],
      });
      expect(result).toBe('Bob');
    });

    it('returns empty string when entry not found', () => {
      const template = '{{findById items "c" "name"}}';
      const result = interpolate(template, {
        items: [
          { id: 'a', name: 'Alice' },
          { id: 'b', name: 'Bob' },
        ],
      });
      expect(result).toBe('');
    });
  });

  describe('includes helper', () => {
    it.each([
      { value: 'Next.js', position: 'first' },
      { value: 'React', position: 'middle' },
      { value: 'Vue', position: 'last' },
    ])('returns true when value ($value) is $position in list', ({ value }) => {
      const template =
        "{{#if (includes framework 'Next.js React Vue')}}found{{else}}not found{{/if}}";
      const result = interpolate(template, { framework: value });
      expect(result).toBe('found');
    });

    it('returns false when value is not in list', () => {
      const template = "{{#if (includes framework 'Next.js React')}}found{{else}}not found{{/if}}";
      const result = interpolate(template, { framework: 'Angular' });
      expect(result).toBe('not found');
    });

    it('handles single value in list', () => {
      const template = "{{#if (includes db 'PostgreSQL')}}found{{else}}not found{{/if}}";
      const result = interpolate(template, { db: 'PostgreSQL' });
      expect(result).toBe('found');
    });

    it('returns false for non-string value input', () => {
      const template = "{{#if (includes value 'foo bar')}}found{{else}}not found{{/if}}";
      const result = interpolate(template, { value: 123 });
      expect(result).toBe('not found');
    });

    it('returns false for non-string list input', () => {
      const template = '{{#if (includes value invalidList)}}found{{else}}not found{{/if}}';
      const result = interpolate(template, { value: 'foo', invalidList: 123 });
      expect(result).toBe('not found');
    });

    it('handles empty string value', () => {
      const template = "{{#if (includes value 'foo bar')}}found{{else}}not found{{/if}}";
      const result = interpolate(template, { value: '' });
      expect(result).toBe('not found');
    });

    it('handles empty string list', () => {
      const template = "{{#if (includes value '')}}found{{else}}not found{{/if}}";
      const result = interpolate(template, { value: 'foo' });
      expect(result).toBe('not found');
    });

    it('handles list with multiple spaces', () => {
      const template =
        "{{#if (includes db 'PostgreSQL  MySQL   SQLite')}}found{{else}}not found{{/if}}";
      const result = interpolate(template, { db: 'MySQL' });
      expect(result).toBe('found');
    });

    it('is case-sensitive', () => {
      const template = "{{#if (includes framework 'react vue')}}found{{else}}not found{{/if}}";
      const result = interpolate(template, { framework: 'React' });
      expect(result).toBe('not found');
    });

    it('requires exact match (not substring)', () => {
      const template = "{{#if (includes db 'PostgreSQL MySQL')}}found{{else}}not found{{/if}}";
      const result = interpolate(template, { db: 'Postgre' });
      expect(result).toBe('not found');
    });

    it('works with complex values containing spaces in quotes', () => {
      const template =
        "{{#if (includes framework 'Next.js Nuxt.js Create-React-App')}}found{{else}}not found{{/if}}";
      const result = interpolate(template, { framework: 'Create-React-App' });
      expect(result).toBe('found');
    });
  });

  describe('not helper', () => {
    it('negates truthy values', () => {
      const template = '{{#if (not flag)}}not set{{else}}set{{/if}}';
      const result = interpolate(template, { flag: true });
      expect(result).toBe('set');
    });

    it('negates falsy values', () => {
      const template = '{{#if (not flag)}}not set{{else}}set{{/if}}';
      const result = interpolate(template, { flag: false });
      expect(result).toBe('not set');
    });

    it('works with eq helper', () => {
      const template = "{{#if (not (eq value 'None'))}}has value{{else}}no value{{/if}}";
      const result = interpolate(template, { value: 'Something' });
      expect(result).toBe('has value');
    });

    it('works with eq helper negating match', () => {
      const template = "{{#if (not (eq value 'None'))}}has value{{else}}no value{{/if}}";
      const result = interpolate(template, { value: 'None' });
      expect(result).toBe('no value');
    });

    it('handles undefined values', () => {
      const template = '{{#if (not value)}}not set{{else}}set{{/if}}';
      const result = interpolate(template, {});
      expect(result).toBe('not set');
    });

    it('handles empty strings', () => {
      const template = '{{#if (not value)}}empty{{else}}not empty{{/if}}';
      const result = interpolate(template, { value: '' });
      expect(result).toBe('empty');
    });

    it('handles zero', () => {
      const template = '{{#if (not value)}}zero{{else}}not zero{{/if}}';
      const result = interpolate(template, { value: 0 });
      expect(result).toBe('zero');
    });
  });

  describe('or helper', () => {
    it('returns true when first argument is truthy', () => {
      const template = '{{#if (or a b)}}found{{else}}not found{{/if}}';
      const result = interpolate(template, { a: true, b: false });
      expect(result).toBe('found');
    });

    it('returns true when second argument is truthy', () => {
      const template = '{{#if (or a b)}}found{{else}}not found{{/if}}';
      const result = interpolate(template, { a: false, b: true });
      expect(result).toBe('found');
    });

    it('returns true when both arguments are truthy', () => {
      const template = '{{#if (or a b)}}found{{else}}not found{{/if}}';
      const result = interpolate(template, { a: true, b: true });
      expect(result).toBe('found');
    });

    it('returns false when both arguments are falsy', () => {
      const template = '{{#if (or a b)}}found{{else}}not found{{/if}}';
      const result = interpolate(template, { a: false, b: false });
      expect(result).toBe('not found');
    });

    it.each(['A', 'B'])('matches when type is %s via eq helper', (type) => {
      const template = "{{#if (or (eq type 'A') (eq type 'B'))}}matches{{else}}no match{{/if}}";
      const result = interpolate(template, { type });
      expect(result).toBe('matches');
    });

    it('returns false when no conditions match', () => {
      const template = "{{#if (or (eq type 'A') (eq type 'B'))}}matches{{else}}no match{{/if}}";
      const result = interpolate(template, { type: 'C' });
      expect(result).toBe('no match');
    });

    it('works with includes helper', () => {
      const template =
        "{{#if (or (eq typescript 'yes') (includes quality 'ESLint Prettier'))}}configured{{else}}not configured{{/if}}";
      const result = interpolate(template, { typescript: 'no', quality: 'ESLint' });
      expect(result).toBe('configured');
    });
  });
});
