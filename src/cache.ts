// Content caching functionality with modification time tracking

import { getFullFileListingAPI, readNoteAPI, getCacheGeneration } from './silverbullet-api.js';
import type { CacheEntry } from './types.js';

// Content cache with modification time tracking
const contentCache = new Map<string, CacheEntry & { generation: number }>();

// Function to get cached content or fetch if needed
export async function getCachedNoteContent(
    filename: string,
    enableCaching: boolean = true
): Promise<string> {
    if (!enableCaching) {
        return await readNoteAPI(filename);
    }

    // Proper invalidation based on SilverBullet metadata
    // Fetch full listing including lastModified timestamps
    const generation = getCacheGeneration();
    const files = await getFullFileListingAPI();
    const noteInfo = files.find((f) => f.name === filename);
    if (!noteInfo) {
        throw new Error(`Note ${filename} not found`);
    }

    const cached = contentCache.get(filename);
    // Compare actual lastModified timestamps
    if (cached && cached.generation === generation && cached.lastModified === noteInfo.lastModified) {
        return cached.content;
    }

    // Fetch fresh content
    const content = await readNoteAPI(filename);

    // Update cache with actual lastModified timestamp
    if (generation === getCacheGeneration()) {
        // Bound retained note contents in a long-running server.
        if (contentCache.size >= 256) contentCache.delete(contentCache.keys().next().value!);
        contentCache.set(filename, { content, lastModified: noteInfo.lastModified, generation });
    }

    return content;
}
