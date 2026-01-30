/**
 * Adapter interfaces for platform-specific functionality.
 * These allow the same parsing code to work with Node.js and Bun.
 */

/**
 * Interface for cryptographic operations.
 */
export interface CryptoAdapter {
  /**
   * Compute SHA-256 hash of a string.
   * @param content - The string to hash
   * @returns Hex-encoded hash string
   */
  sha256(content: string): string;
}

/**
 * Interface for file system operations.
 */
export interface FileAdapter {
  /**
   * Read a file as text.
   * @param path - Absolute path to the file
   * @returns File contents as a string
   * @throws If file does not exist or cannot be read
   */
  readText(path: string): Promise<string>;

  /**
   * Check if a file exists.
   * @param path - Absolute path to the file
   * @returns true if file exists, false otherwise
   */
  exists(path: string): Promise<boolean>;
}

/**
 * Combined adapter for all platform-specific operations.
 */
export interface PlatformAdapter {
  crypto: CryptoAdapter;
  fs: FileAdapter;
}
