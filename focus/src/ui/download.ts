import type { Platform } from '@/platform/types';

/**
 * Save an export through the platform (browser download, Downloads folder on desktop,
 * share sheet on Android). Returns a message describing where it went, if known.
 */
export async function saveFile(platform: Platform, name: string, data: Uint8Array | string, mime: string): Promise<string | null> {
  const path = await platform.exportFile(name, data, mime);
  return path ? `Saved to ${path}` : null;
}
