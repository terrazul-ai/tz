/**
 * Node.js adapter implementation.
 * Uses node:crypto and node:fs/promises for platform operations.
 */

import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { readFile, access } from 'node:fs/promises';

import type { CryptoAdapter, FileAdapter, PlatformAdapter } from './types.js';

/**
 * Node.js crypto adapter using node:crypto.
 */
export const nodeCrypto: CryptoAdapter = {
  sha256(content: string): string {
    return createHash('sha256').update(content).digest('hex');
  },
};

/**
 * Node.js file system adapter using node:fs/promises.
 */
export const nodeFs: FileAdapter = {
  async readText(path: string): Promise<string> {
    return readFile(path, 'utf8');
  },

  async exists(path: string): Promise<boolean> {
    try {
      await access(path, constants.F_OK);
      return true;
    } catch {
      return false;
    }
  },
};

/**
 * Combined Node.js platform adapter.
 */
export const nodeAdapter: PlatformAdapter = {
  crypto: nodeCrypto,
  fs: nodeFs,
};
