/**
 * Bun adapter implementation.
 * Uses Bun.CryptoHasher and Bun.file() for platform operations.
 */

import type { CryptoAdapter, FileAdapter, PlatformAdapter } from './types.js';

// Type declarations for Bun globals (avoids requiring bun-types as a hard dependency)
declare const Bun: {
  CryptoHasher: new (algorithm: string) => {
    update(data: string): void;
    digest(encoding: 'hex'): string;
  };
  file(path: string): {
    text(): Promise<string>;
    exists(): Promise<boolean>;
  };
};

/**
 * Bun crypto adapter using Bun.CryptoHasher.
 */
export const bunCrypto: CryptoAdapter = {
  sha256(content: string): string {
    const hasher = new Bun.CryptoHasher('sha256');
    hasher.update(content);
    return hasher.digest('hex');
  },
};

/**
 * Bun file system adapter using Bun.file().
 */
export const bunFs: FileAdapter = {
  async readText(path: string): Promise<string> {
    return Bun.file(path).text();
  },

  async exists(path: string): Promise<boolean> {
    return Bun.file(path).exists();
  },
};

/**
 * Combined Bun platform adapter.
 */
export const bunAdapter: PlatformAdapter = {
  crypto: bunCrypto,
  fs: bunFs,
};
