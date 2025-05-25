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

export async function listNotesAPI(): Promise<NoteInfo[]> {
    const url = `${SB_API_BASE_URL}/index.json`;
    const fetchHeaders = createFetchHeaders();

    let response: Response;
    try {
        response = await fetch(url, { headers: fetchHeaders });
    } catch (error) {
        handleFetchError(url, error);
    }

    if (!response!.ok) {
        await handleResponseError(url, response!, 'to list notes');
    }

    const responseClone = response!.clone();

    try {
        const files: SBFile[] = await response!.json();
        return files
            .filter((f) => f.name.endsWith('.md'))
            .map((f) => ({ name: f.name, perm: f.perm }));
    } catch (error) {
        console.error(`[listNotesAPI] Failed to parse JSON response:`, error);

        try {
            const responseText = await responseClone.text();
            console.error(`[listNotesAPI] Response body (first 500 chars): ${responseText.substring(0, 500)}`);
        } catch (textError) {
            console.error(`[listNotesAPI] Could not read response body as text:`, textError);
        }

        throw new Error(
            `Failed to parse JSON response from SilverBullet API: ${
                error instanceof Error ? error.message : String(error)
            }`
        );
    }
}

export async function getFullFileListingAPI(): Promise<SBFile[]> {
    const url = `${SB_API_BASE_URL}/index.json`;
    const fetchHeaders = createFetchHeaders();

    const response = await fetch(url, { headers: fetchHeaders });

    if (!response.ok) {
        throw new Error(`Failed to get file listing: ${response.status} ${response.statusText}`);
    }

    const files: SBFile[] = await response.json();
    return files.filter((f) => f.name.endsWith('.md'));
}

export async function readNoteAPI(filename: string): Promise<string> {
    const url = `${SB_API_BASE_URL}/${encodeURIComponent(filename)}`;
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
    const url = `${SB_API_BASE_URL}/${encodeURIComponent(filename)}`;
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
}

export async function deleteNoteAPI(filename: string): Promise<void> {
    const url = `${SB_API_BASE_URL}/${encodeURIComponent(filename)}`;
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
}