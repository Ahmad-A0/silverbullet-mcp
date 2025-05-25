// Content caching functionality with modification time tracking

import { getFullFileListingAPI, readNoteAPI } from './silverbullet-api.js';
import type { CacheEntry } from './types.js';

// Content cache with modification time tracking
const contentCache: { [filename: string]: CacheEntry } = {};

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
    const files = await getFullFileListingAPI();
    const noteInfo = files.find((f) => f.name === filename);
    if (!noteInfo) {
        throw new Error(`Note ${filename} not found`);
    }

    const cached = contentCache[filename];
    // Compare actual lastModified timestamps
    if (cached && cached.lastModified >= noteInfo.lastModified) {
        return cached.content;
    }

    // Fetch fresh content
    const content = await readNoteAPI(filename);

    // Update cache with actual lastModified timestamp
    contentCache[filename] = {
        content,
        lastModified: noteInfo.lastModified,
    };

    return content;
}