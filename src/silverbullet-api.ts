// SilverBullet API interaction functions

import { SB_API_BASE_URL, SB_AUTH_TOKEN } from './config.js';
import type { SBFile, NoteInfo } from './types.js';

const createFetchHeaders = (): HeadersInit => {
    const headers: HeadersInit = {
        'X-Sync-Mode': 'true',
    };
    if (SB_AUTH_TOKEN) {
        headers['Authorization'] = `Bearer ${SB_AUTH_TOKEN}`;
    }
    return headers;
};

const handleFetchError = (url: string, error: unknown): never => {
    console.error(`[API] Fetch failed for ${url}:`, error);
    throw new Error(
        `Failed to connect to SilverBullet API at ${url}: ${
            error instanceof Error ? error.message : String(error)
        }`
    );
};

const handleResponseError = async (url: string, response: Response, context: string): Promise<never> => {
    const responseText = await response.text();
    console.error(`[API] Error response body for ${context} (first 500 chars): ${responseText.substring(0, 500)}`);
    throw new Error(`Failed ${context} from SilverBullet API (${url}): ${response.status} ${response.statusText}`);
};

// ---------------------------------------------------------------------------
// Cached file listing (30-second TTL)
//
// Both listNotesAPI() and getFullFileListingAPI() delegate to fetchFileListing()
// so that repeated calls within a session share a single HTTP request to /.fs
// instead of re-fetching thousands of files every time.  Concurrent callers
// that hit a cold cache are deduplicated via an in-flight promise.
//
// Call invalidateListingCache() after writes/deletes so the next read sees
// fresh metadata (which in turn lets content caches in cache.ts re-validate).
// ---------------------------------------------------------------------------

const LISTING_TTL_MS = 30_000;
let listingCache: { files: SBFile[]; timestamp: number } | null = null;
let listingFetchPromise: Promise<SBFile[]> | null = null;

/**
 * Invalidate the cached file listing.  Should be called after any write or
 * delete so subsequent reads observe fresh lastModified timestamps.
 */
export function invalidateListingCache(): void {
    listingCache = null;
}

async function fetchFileListing(): Promise<SBFile[]> {
    const now = Date.now();

    // Return cached listing if still fresh
    if (listingCache && now - listingCache.timestamp < LISTING_TTL_MS) {
        return listingCache.files;
    }

    // Deduplicate concurrent cold-cache fetches
    if (listingFetchPromise) {
        return listingFetchPromise;
    }

    listingFetchPromise = (async () => {
        const url = `${SB_API_BASE_URL}/.fs`;
        const fetchHeaders = createFetchHeaders();

        let response: Response;
        try {
            response = await fetch(url, { headers: fetchHeaders });
        } catch (error) {
            handleFetchError(url, error);
        }

        if (!response!.ok) {
            await handleResponseError(url, response!, 'to list files');
        }

        const responseClone = response!.clone();

        try {
            const files: SBFile[] = await response!.json();
            const filtered = files.filter(
                (f) => f.name.endsWith('.md') && !f.name.startsWith('Library')
            );
            listingCache = { files: filtered, timestamp: Date.now() };
            return filtered;
        } catch (error) {
            console.error(`[fetchFileListing] Failed to parse JSON response:`, error);

            try {
                const responseText = await responseClone.text();
                console.error(`[fetchFileListing] Response body (first 500 chars): ${responseText.substring(0, 500)}`);
            } catch (textError) {
                console.error(`[fetchFileListing] Could not read response body as text:`, textError);
            }

            throw new Error(
                `Failed to parse JSON response from SilverBullet API: ${
                    error instanceof Error ? error.message : String(error)
                }`
            );
        }
    })();

    try {
        return await listingFetchPromise;
    } finally {
        listingFetchPromise = null;
    }
}

/**
 * Return a lightweight list of notes (name + permission).
 * Uses the 30-second cached listing.
 */
export async function listNotesAPI(): Promise<NoteInfo[]> {
    const files = await fetchFileListing();
    return files.map((f) => ({ name: f.name, perm: f.perm }));
}

/**
 * Return the full file listing including lastModified, contentType, size, perm.
 * Uses the 30-second cached listing.
 */
export async function getFullFileListingAPI(): Promise<SBFile[]> {
    return fetchFileListing();
}

export async function readNoteAPI(filename: string): Promise<string> {
    console.log(`[readNoteAPI] Reading note ${filename}`);
    const url = `${SB_API_BASE_URL}/.fs/${encodeURIComponent(filename)}`;
    const fetchHeaders = createFetchHeaders();

    let response: Response;
    try {
        response = await fetch(url, { headers: fetchHeaders });
    } catch (error) {
        console.error(`[readNoteAPI] Fetch failed for ${filename}:`, error);
        handleFetchError(url, error);
    }

    if (!response!.ok) {
        await handleResponseError(url, response!, `to read note ${filename}`);
    }

    try {
        const content = await response!.text();
        return content;
    } catch (error) {
        console.error(`[readNoteAPI] Failed to read text content for ${filename}:`, error);
        throw new Error(
            `Failed to read text content for note ${filename}: ${
                error instanceof Error ? error.message : String(error)
            }`
        );
    }
}

export async function writeNoteAPI(filename: string, content: string): Promise<void> {
    const url = `${SB_API_BASE_URL}/.fs/${encodeURIComponent(filename)}`;
    const fetchHeaders: HeadersInit = {
        'Content-Type': 'text/markdown',
        'X-Sync-Mode': 'true',
    };
    if (SB_AUTH_TOKEN) {
        fetchHeaders['Authorization'] = `Bearer ${SB_AUTH_TOKEN}`;
    }

    let response: Response;
    try {
        response = await fetch(url, {
            method: 'PUT',
            headers: fetchHeaders,
            body: content,
        });
    } catch (error) {
        console.error(`[writeNoteAPI] Fetch failed for ${filename}:`, error);
        handleFetchError(url, error);
    }

    if (!response!.ok) {
        await handleResponseError(url, response!, `to write note ${filename}`);
    }

    // Invalidate listing cache so subsequent reads see fresh lastModified
    invalidateListingCache();
}

export async function deleteNoteAPI(filename: string): Promise<void> {
    const url = `${SB_API_BASE_URL}/.fs/${encodeURIComponent(filename)}`;
    const fetchHeaders = createFetchHeaders();

    let response: Response;
    try {
        response = await fetch(url, {
            method: 'DELETE',
            headers: fetchHeaders,
        });
    } catch (error) {
        console.error(`[deleteNoteAPI] Fetch failed for ${filename}:`, error);
        handleFetchError(url, error);
    }

    if (!response!.ok) {
        await handleResponseError(url, response!, `to delete note ${filename}`);
    }

    // Invalidate listing cache so subsequent reads don't see the deleted file
    invalidateListingCache();
}
