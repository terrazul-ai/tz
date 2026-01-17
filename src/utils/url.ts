/**
 * URL utility functions for normalizing and handling package URLs.
 */

/**
 * Strips query parameters from a URL.
 *
 * This is used to normalize signed URLs (e.g., AWS S3 presigned URLs) before storing
 * them in the lockfile. Signed URLs contain temporary credentials that expire,
 * making them unsuitable for deterministic lockfiles.
 *
 * @param url - The URL to normalize
 * @returns The URL without query parameters, or the original string if not a valid URL
 */
export function stripQueryParams(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.search = '';
    return parsed.toString();
  } catch {
    // Return as-is if not a valid URL
    return url;
  }
}
