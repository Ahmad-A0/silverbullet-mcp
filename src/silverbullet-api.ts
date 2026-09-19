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

export class SilverBulletAPIError extends Error {
    constructor(message: string, public readonly status: number) { super(message); }
}

const handleResponseError = async (url: string, response: Response, context: string): Promise<never> => {
    const responseText = await response.text();
    console.error(`[API] Error response body for ${context} (first 500 chars): ${responseText.substring(0, 500)}`);
    throw new SilverBulletAPIError(`Failed ${context} from SilverBullet API (${url}): ${response.status} ${response.statusText}${response.status === 412 ? ". Revision conflict: read the note again before retrying." : ""}`, response.status);
};

const LISTING_TTL_MS = 30_000;
let generation = 0;
let listingCache: { files: SBFile[]; expires: number } | undefined;
let listingFlight: Promise<SBFile[]> | undefined;

export function getCacheGeneration(): number { return generation; }

export function invalidateListingCache(): void {
    generation++;
    listingCache = undefined;
    // New readers must not join a request made before the mutation.
    listingFlight = undefined;
}

async function fetchFileListing(): Promise<SBFile[]> {
    if (listingCache && Date.now() < listingCache.expires) return listingCache.files;
    if (listingFlight) return listingFlight;
    const startedGeneration = generation;
    const flight = (async () => {
        const url = `${SB_API_BASE_URL}/.fs`;
        const response = await fetch(url, { headers: createFetchHeaders() });
        if (!response.ok) await handleResponseError(url, response, 'to list files');
        const files: SBFile[] = await response.json();
        const filtered = files.filter(f => f.name.endsWith('.md') && !f.name.startsWith('Library'));
        if (startedGeneration === generation) {
            listingCache = { files: filtered, expires: Date.now() + LISTING_TTL_MS };
        }
        return filtered;
    })();
    listingFlight = flight;
    try { return await flight; }
    finally { if (listingFlight === flight) listingFlight = undefined; }
}

export async function listNotesAPI(): Promise<NoteInfo[]> {
    return (await fetchFileListing()).map(({ name, perm }) => ({ name, perm }));
}

export async function getFullFileListingAPI(): Promise<SBFile[]> {
    // Callers cannot mutate shared cache entries.
    return (await fetchFileListing()).map(file => ({ ...file }));
}

export async function readNoteAPI(filename: string): Promise<string> {
    return (await readNoteSnapshotAPI(filename)).content;
}

export async function readNoteSnapshotAPI(filename: string): Promise<{ content: string; revision: string | null }> {
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
        // Buffer decoding preserves a UTF-8 BOM, unlike Response.text().
        const content = Buffer.from(await response!.arrayBuffer()).toString('utf8');
        return { content, revision: response!.headers.get('etag') };
    } catch (error) {
        console.error(`[readNoteAPI] Failed to read text content for ${filename}:`, error);
        throw new Error(
            `Failed to read text content for note ${filename}: ${
                error instanceof Error ? error.message : String(error)
            }`
        );
    }
}

export async function writeNoteAPI(filename: string, content: string,
    options: { expectedRevision?: string; createOnly?: boolean } = {}
): Promise<string | null> {
    const url = `${SB_API_BASE_URL}/.fs/${encodeURIComponent(filename)}`;
    const fetchHeaders: HeadersInit = {
        'Content-Type': 'text/markdown',
        'X-Sync-Mode': 'true',
    };
    if (SB_AUTH_TOKEN) {
        fetchHeaders['Authorization'] = `Bearer ${SB_AUTH_TOKEN}`;
    }

    if (options.expectedRevision) fetchHeaders['If-Match'] = options.expectedRevision;
    if (options.createOnly) fetchHeaders['If-None-Match'] = '*';
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
    invalidateListingCache();
    return response!.headers.get('etag');
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
    invalidateListingCache();
}
