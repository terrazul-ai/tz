import { describe, it, expect } from 'vitest';

import { stripQueryParams } from '../../../src/utils/url';

describe('utils/url', () => {
  describe('stripQueryParams', () => {
    it('removes query parameters from a signed S3 URL', () => {
      const signedUrl =
        'https://bucket.s3.amazonaws.com/packages/@scope/pkg/1.0.0.tar.gz?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIA...&X-Amz-Date=20240101T000000Z&X-Amz-Expires=3600&X-Amz-SignedHeaders=host&X-Amz-Signature=abc123';
      const result = stripQueryParams(signedUrl);
      expect(result).toBe('https://bucket.s3.amazonaws.com/packages/@scope/pkg/1.0.0.tar.gz');
    });

    it('handles URLs without query parameters', () => {
      const cleanUrl = 'https://registry.example.com/packages/pkg/1.0.0.tar.gz';
      const result = stripQueryParams(cleanUrl);
      expect(result).toBe(cleanUrl);
    });

    it('handles URLs with only a question mark', () => {
      const url = 'https://example.com/path?';
      const result = stripQueryParams(url);
      expect(result).toBe('https://example.com/path');
    });

    it('preserves hash fragments while removing query params', () => {
      const url = 'https://example.com/path?foo=bar#section';
      const result = stripQueryParams(url);
      expect(result).toBe('https://example.com/path#section');
    });

    it('handles URLs with port numbers', () => {
      const url = 'http://localhost:8787/packages/pkg?token=abc';
      const result = stripQueryParams(url);
      expect(result).toBe('http://localhost:8787/packages/pkg');
    });

    it('returns invalid strings as-is', () => {
      const invalid = 'not-a-valid-url';
      const result = stripQueryParams(invalid);
      expect(result).toBe(invalid);
    });

    it('returns empty string as-is', () => {
      const result = stripQueryParams('');
      expect(result).toBe('');
    });

    it('handles URLs with encoded characters', () => {
      const url = 'https://example.com/packages/@scope%2Fpkg/1.0.0.tar.gz?sig=abc';
      const result = stripQueryParams(url);
      expect(result).toBe('https://example.com/packages/@scope%2Fpkg/1.0.0.tar.gz');
    });

    it('handles URLs with multiple query parameters', () => {
      const url = 'https://example.com/path?a=1&b=2&c=3';
      const result = stripQueryParams(url);
      expect(result).toBe('https://example.com/path');
    });
  });
});
