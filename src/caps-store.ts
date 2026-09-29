/**
 * In-memory capability verdict cache for the hybrid search strategy.
 *
 * Probing the Runtime API can be slow (it may boot a headless Chrome client),
 * so the verdict (runtime available? which search library?) is cached in
 * process memory with a TTL. Keyed by base URL so multiple spaces don't
 * collide. A failed index search calls clear(), which drops the verdict so
 * the next search re-probes.
 */

export interface CapsEntry {
    available: boolean;
    engine?: string;
}

const CAPS_TTL_MS = 10 * 60 * 1000;

const store = new Map<string, { caps: CapsEntry; savedAt: number }>();

export function loadCaps(baseUrl: string): CapsEntry | null {
    const entry = store.get(baseUrl);
    if (!entry) return null;
    if (Date.now() - entry.savedAt >= CAPS_TTL_MS) {
        store.delete(baseUrl);
        return null;
    }
    return entry.caps;
}

export function saveCaps(baseUrl: string, caps: CapsEntry): void {
    store.set(baseUrl, { caps, savedAt: Date.now() });
}

export function clearCaps(baseUrl: string): void {
    store.delete(baseUrl);
}

/** Test isolation hook: drops every cached verdict. */
export function resetCapsCache(): void {
    store.clear();
}
