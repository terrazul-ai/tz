/**
 * Snippet cache management for deterministic template rendering
 * Caches askUser and askAgent responses in a separate TOML file
 */

import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import * as TOML from '@iarna/toml';

import { getCliVersion } from '../utils/version.js';

import type { CachedSnippet, PackageSnippetCache, SnippetCache } from '../types/snippet.js';

export class SnippetCacheManager {
  private static readonly CACHE_VERSION = 1;
  private cache: SnippetCache;

  constructor(private readonly cacheFilePath: string) {
    // Initialize with empty cache; actual reading happens in read()
    this.cache = this.createEmptyCache();
  }

  /**
   * Create an empty cache structure
   */
  private createEmptyCache(): SnippetCache {
    return {
      version: SnippetCacheManager.CACHE_VERSION,
      packages: {},
      metadata: {
        generatedAt: new Date().toISOString(),
        cliVersion: getCliVersion(),
      },
    };
  }

  /**
   * Read cache from disk
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async read(): Promise<SnippetCache> {
    if (!existsSync(this.cacheFilePath)) {
      this.cache = this.createEmptyCache();
      return this.cache;
    }

    try {
      const content = readFileSync(this.cacheFilePath, 'utf8');

      interface ParsedCache {
        version?: number;
        packages?: Record<string, unknown>;
        metadata?: {
          generatedAt?: string;
          generated_at?: string;
          cliVersion?: string;
          cli_version?: string;
        };
      }

      const parsed = TOML.parse(content) as ParsedCache;

      // Validate structure
      if (!parsed.version || !parsed.packages || !parsed.metadata) {
        console.warn('Invalid cache file structure, creating new cache');
        this.cache = this.createEmptyCache();
        return this.cache;
      }

      // Parse packages with their snippet arrays
      const packages: Record<string, PackageSnippetCache> = {};

      for (const [pkgName, pkgData] of Object.entries(parsed.packages)) {
        const pkg = pkgData as {
          version?: string;
          snippets?: Array<{
            id?: string;
            type?: string;
            prompt_excerpt?: string;
            promptExcerpt?: string;
            value?: string;
            timestamp?: string;
            tool?: string;
          }>;
        };

        if (!pkg.version || !Array.isArray(pkg.snippets)) {
          console.warn(`Invalid package data for ${pkgName}, skipping`);
          continue;
        }

        const snippets: CachedSnippet[] = pkg.snippets
          .filter(
            (s) =>
              s.id && s.type && (s.promptExcerpt || s.prompt_excerpt) && s.value && s.timestamp,
          )
          .map((s) => ({
            id: s.id!,
            type: s.type as 'askUser' | 'askAgent',
            promptExcerpt: s.promptExcerpt || s.prompt_excerpt!,
            value: s.value!,
            timestamp: s.timestamp!,
            tool: s.tool as 'claude' | 'codex' | 'gemini' | undefined,
          }));

        packages[pkgName] = {
          version: pkg.version,
          snippets,
        };
      }

      const generatedAt = parsed.metadata.generatedAt ?? parsed.metadata.generated_at ?? '';
      const cliVersion = parsed.metadata.cliVersion ?? parsed.metadata.cli_version ?? '';

      this.cache = {
        version: parsed.version,
        packages,
        metadata: {
          generatedAt,
          cliVersion,
        },
      };

      return this.cache;
    } catch (error) {
      console.error('Error parsing cache file:', error);
      this.cache = this.createEmptyCache();
      return this.cache;
    }
  }

  /**
   * Write cache to disk with deterministic ordering (atomic write)
   */
  async write(cache: SnippetCache): Promise<void> {
    // Ensure directory exists
    const dir = path.dirname(this.cacheFilePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    // Sort packages alphabetically for determinism
    const sortedPackages: Record<string, unknown> = {};
    const packageNames = Object.keys(cache.packages).sort();

    for (const name of packageNames) {
      const pkg = cache.packages[name];

      // Sort snippets by id for determinism
      const sortedSnippets = [...pkg.snippets].sort((a, b) => a.id.localeCompare(b.id));

      // Convert to snake_case for TOML
      sortedPackages[name] = {
        version: pkg.version,
        snippets: sortedSnippets.map((s) => ({
          id: s.id,
          type: s.type,
          prompt_excerpt: s.promptExcerpt,
          value: s.value,
          timestamp: s.timestamp,
          ...(s.tool && { tool: s.tool }),
        })),
      };
    }

    // Create TOML structure
    const tomlData = {
      version: SnippetCacheManager.CACHE_VERSION,
      packages: sortedPackages,
      metadata: {
        generated_at: new Date().toISOString(),
        cli_version: getCliVersion(),
      },
    };

    // Convert to TOML string
    const tomlString = TOML.stringify(tomlData as unknown as TOML.JsonMap);

    // Atomic write: write to temp file then rename
    const tempFile = path.join(
      tmpdir(),
      `tz-cache-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`,
    );

    try {
      await writeFile(tempFile, tomlString, 'utf8');
      await rename(tempFile, this.cacheFilePath);
    } catch (error) {
      // Clean up temp file on error
      try {
        await writeFile(tempFile, '', 'utf8').catch(() => {});
      } catch {
        // ignore
      }
      throw error;
    }

    // Update in-memory cache
    this.cache = cache;
  }

  /**
   * Get cached snippet value
   */
  getSnippet(packageName: string, version: string, snippetId: string): CachedSnippet | null {
    const pkgCache = this.cache.packages[packageName];
    if (!pkgCache || pkgCache.version !== version) {
      return null;
    }

    return pkgCache.snippets.find((s) => s.id === snippetId) || null;
  }

  /**
   * Store snippet result
   */
  async setSnippet(packageName: string, version: string, snippet: CachedSnippet): Promise<void> {
    if (!this.cache.packages[packageName]) {
      this.cache.packages[packageName] = {
        version,
        snippets: [],
      };
    }

    const pkgCache = this.cache.packages[packageName];

    // Update version if different
    pkgCache.version = version;

    // Find and update existing snippet, or add new one
    const existingIndex = pkgCache.snippets.findIndex((s) => s.id === snippet.id);

    if (existingIndex >= 0) {
      pkgCache.snippets[existingIndex] = snippet;
    } else {
      pkgCache.snippets.push(snippet);
    }

    await this.write(this.cache);
  }

  /**
   * Clear cache for a specific package
   */
  async clearPackage(packageName: string): Promise<void> {
    delete this.cache.packages[packageName];
    await this.write(this.cache);
  }

  /**
   * Clear entire cache
   */
  async clearAll(): Promise<void> {
    this.cache.packages = {};
    await this.write(this.cache);
  }

  /**
   * Prune stale entries (packages not in manifest)
   */
  async prune(manifestPackages: string[]): Promise<void> {
    const toRemove = Object.keys(this.cache.packages).filter(
      (pkg) => !manifestPackages.includes(pkg),
    );

    if (toRemove.length > 0) {
      for (const pkg of toRemove) {
        delete this.cache.packages[pkg];
      }
      await this.write(this.cache);
    }
  }
}
