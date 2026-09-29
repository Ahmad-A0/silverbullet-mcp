/**
 * Hybrid search strategy: probe → validate → fallback.
 *
 * Tier 1 (fast): if the SilverBullet Runtime API is reachable and a search
 * library (silversearch or basic-search) is installed, use it to rank pages,
 * then fetch only the notes on the current result page for line-level
 * matches.
 *
 * Tier 2 (always works): full scan — read every note and regex it (the
 * original behavior).
 *
 * The capability verdict (runtime available? which engine?) is cached via the
 * injected `caps` store (in-process, TTL-managed by the caller) so the probe
 * doesn't run on every tool call. A search-time failure invalidates the
 * cached verdict. Zero index results are validated against the notes
 * themselves, because a stale or empty index must never cause false
 * negatives.
 */

export interface NoteMatches {
    type: 'title' | 'content';
    line: number;
    content: string;
    context?: string;
    matchCount: number;
    startLine?: number;
    endLine?: number;
}

export interface SearchResult {
    filename: string;
    permission: 'ro' | 'rw';
    matches: NoteMatches[];
    score: number;
}

export interface HybridSearchOutcome {
    /** Which path produced the results. */
    source: 'index' | 'scan';
    /** Present when the caller should know something unusual happened. */
    notice?: string;
    /** Results for the requested page only. */
    results: SearchResult[];
    totalResults: number;
    /**
     * Total match count. On the scan path this covers ALL results; on the
     * index path only the current page's notes were read, so it covers the
     * page window only.
     */
    totalMatches: number;
    totalPages: number;
    page: number;
    /** 0-based index of the first result on this page (for numbering). */
    startIndex: number;
}

export interface CapsStore {
    get(): { available: boolean; engine?: string } | null;
    save(caps: { available: boolean; engine?: string }): void;
    clear(): void;
}

export interface SearchContext {
    listNotes(): Promise<{ name: string; perm?: string; lastModified?: number }[]>;
    readNote(filename: string): Promise<string>;
    runtime: {
        probeCapabilities(): Promise<{ ok: boolean; caps?: { basicSearch: boolean; silversearch: boolean }; error?: string }>;
        fulltextSearch(term: string, engine: string): Promise<{ ok: boolean; results?: { file: string; score: number }[]; error?: string }>;
    };
    caps: CapsStore;
}

export interface HybridSearchOptions {
    ctx: SearchContext;
    query: string;
    searchType?: 'content' | 'title' | 'both';
    caseSensitive?: boolean;
    /** false treats the query as a literal string (upstream useRegex=false). */
    useRegex?: boolean;
    maxResults?: number;
    page?: number;
    mode?: 'auto' | 'scan' | 'index';
    concise?: boolean;
    contextLines?: number;
    /** Directly inject index results (used by tests to bypass the runtime). */
    indexResults?: { file: string; score: number }[];
}

function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function tokenize(query: string): string[] {
    return String(query)
        .split(/\s+/)
        .filter((t) => t.length > 0);
}

function buildTermRegex(tokens: string[], caseSensitive: boolean): RegExp | null {
    if (!tokens || tokens.length === 0) return null;
    return new RegExp(tokens.map(escapeRegex).join('|'), caseSensitive ? 'g' : 'gi');
}

function buildQueryRegex(query: string, caseSensitive: boolean, allowRegex = true): RegExp {
    const flags = caseSensitive ? 'g' : 'gi';
    if (!allowRegex) return new RegExp(escapeRegex(query), flags);
    try {
        return new RegExp(query, flags);
    } catch {
        // Invalid regex — treat as literal rather than failing the whole search.
        return new RegExp(escapeRegex(query), flags);
    }
}

function finish(opts: {
    results: SearchResult[];
    maxResults: number;
    page: number;
    source: 'index' | 'scan';
    totalOverride?: number;
}): HybridSearchOutcome {
    const totalResults = opts.totalOverride ?? opts.results.length;
    // For scans, results holds ALL matches (total across the space); for the
    // index path only the current page's notes were read.
    const totalMatches = opts.results.reduce((s, r) => s + r.score, 0);
    const totalPages = Math.max(1, Math.ceil(totalResults / opts.maxResults));
    const start = (opts.page - 1) * opts.maxResults;
    // When totalOverride is set the results are already the current page's
    // window (sliced before line extraction) — don't paginate again.
    const paged =
        opts.totalOverride !== undefined
            ? opts.results
            : opts.results.slice(start, start + opts.maxResults);
    return {
        source: opts.source,
        results: paged,
        totalResults,
        totalMatches,
        totalPages,
        page: opts.page,
        startIndex: start,
    };
}

// Full scan — preserves the original search-notes semantics: the whole query
// is one (JS) regex with literal fallback, ranked by match count, with
// optional context lines in non-concise mode.
async function scanSearch(opts: {
    ctx: SearchContext;
    query: string;
    searchType: 'content' | 'title' | 'both';
    caseSensitive: boolean;
    useRegex: boolean;
    maxResults: number;
    page: number;
    concise: boolean;
    contextLines: number;
}): Promise<HybridSearchOutcome> {
    const { ctx, query, searchType, caseSensitive, maxResults, page, concise, contextLines } = opts;
    const notes = await ctx.listNotes();
    const regex = buildQueryRegex(query, caseSensitive, opts.useRegex);

    const results: SearchResult[] = [];
    for (const note of notes) {
        const matches: NoteMatches[] = [];
        if (searchType === 'title' || searchType === 'both') {
            const titleMatches = Array.from(note.name.matchAll(regex));
            if (titleMatches.length > 0) {
                matches.push({
                    type: 'title',
                    line: 0,
                    content: note.name,
                    matchCount: titleMatches.length,
                });
            }
        }
        if (searchType === 'content' || searchType === 'both') {
            try {
                const content = await ctx.readNote(note.name);
                const lines = content.split('\n');
                lines.forEach((line, lineIndex) => {
                    const lineMatches = Array.from(line.matchAll(regex));
                    if (lineMatches.length > 0) {
                        let contextText = '';
                        if (!concise && contextLines > 0) {
                            const startLine = Math.max(0, lineIndex - contextLines);
                            const endLine = Math.min(lines.length - 1, lineIndex + contextLines);
                            contextText = lines.slice(startLine, endLine + 1).join('\n');
                        }
                        matches.push({
                            type: 'content',
                            line: lineIndex + 1,
                            content: line.trim(),
                            context: contextText,
                            matchCount: lineMatches.length,
                            startLine:
                                contextLines > 0
                                    ? Math.max(0, lineIndex - contextLines) + 1
                                    : undefined,
                            endLine:
                                contextLines > 0
                                    ? Math.min(lines.length - 1, lineIndex + contextLines) + 1
                                    : undefined,
                        });
                    }
                });
            } catch {
                // unreadable note: skip content search, keep going
            }
        }
        if (matches.length > 0) {
            results.push({
                filename: note.name,
                permission: (note.perm as 'ro' | 'rw') ?? 'rw',
                matches,
                score: matches.reduce((s, m) => s + m.matchCount, 0),
            });
        }
    }
    results.sort((a, b) => b.score - a.score);
    return finish({ results, maxResults, page, source: 'scan' });
}

// Extract line matches for the given files (the current result page only).
// Produces the same match shape as the scan path, including context lines in
// non-concise mode.
async function extractLines(opts: {
    ctx: SearchContext;
    files: string[];
    query: string;
    searchType: 'content' | 'title' | 'both';
    caseSensitive: boolean;
    useRegex: boolean;
    concise: boolean;
    contextLines: number;
}): Promise<SearchResult[]> {
    const { ctx, files, query, searchType, caseSensitive, concise, contextLines } = opts;
    // Line matching uses the SAME regex construction as scanSearch (full
    // query with literal fallback) so both paths produce identical matches.
    const regex = buildQueryRegex(query, caseSensitive, opts.useRegex);
    const listing = await ctx.listNotes();
    const perms = new Map(listing.map((n) => [n.name, (n.perm as 'ro' | 'rw') ?? 'rw']));

    const results: SearchResult[] = [];
    for (const file of files) {
        const matches: NoteMatches[] = [];
        if (searchType === 'title' || searchType === 'both') {
            const titleMatches = Array.from(file.matchAll(regex));
            if (titleMatches.length > 0) {
                matches.push({ type: 'title', line: 0, content: file, matchCount: titleMatches.length });
            }
        }
        if (searchType === 'content' || searchType === 'both') {
            try {
                const content = await ctx.readNote(file);
                const lines = content.split('\n');
                lines.forEach((line, lineIndex) => {
                    const lineMatches = Array.from(line.matchAll(regex));
                    if (lineMatches.length > 0) {
                        let contextText = '';
                        if (!concise && contextLines > 0) {
                            const startLine = Math.max(0, lineIndex - contextLines);
                            const endLine = Math.min(lines.length - 1, lineIndex + contextLines);
                            contextText = lines.slice(startLine, endLine + 1).join('\n');
                        }
                        matches.push({
                            type: 'content',
                            line: lineIndex + 1,
                            content: line.trim(),
                            context: contextText,
                            matchCount: lineMatches.length,
                            startLine:
                                contextLines > 0
                                    ? Math.max(0, lineIndex - contextLines) + 1
                                    : undefined,
                            endLine:
                                contextLines > 0
                                    ? Math.min(lines.length - 1, lineIndex + contextLines) + 1
                                    : undefined,
                        });
                    }
                });
            } catch {
                // binary or unreadable: list without line matches
            }
        }
        results.push({
            filename: file,
            permission: perms.get(file) ?? 'rw',
            matches,
            score: matches.reduce((s, m) => s + m.matchCount, 0),
        });
    }
    return results;
}

// Zero-result validation: a stale/empty index must not produce false
// negatives. If the space is small enough, check EVERY note (definitive).
// Otherwise sample a mix of recent and random notes — recent-biased because
// a stale index most commonly misses recently-changed notes.
async function validateZeroResults(opts: {
    ctx: SearchContext;
    query: string;
    caseSensitive: boolean;
    sampleSize: number;
}): Promise<boolean> {
    let notes: { name: string; lastModified?: number }[] = [];
    try {
        notes = await opts.ctx.listNotes();
    } catch {
        return true; // can't validate → can't trust the zero
    }
    const regex = buildTermRegex(tokenize(opts.query), opts.caseSensitive);
    if (!regex) return true; // nothing to validate with → trust

    const sampleHasNoTerm = async (sample: { name: string }[]): Promise<boolean> => {
        for (const note of sample) {
            try {
                const content = await opts.ctx.readNote(note.name);
                if (regex.test(content)) return false; // index is wrong → don't trust
            } catch {
                // skip unreadable sample notes
            }
        }
        return true;
    };

    if (notes.length <= opts.sampleSize) {
        return sampleHasNoTerm(notes);
    }

    notes.sort((a, b) => (b.lastModified ?? 0) - (a.lastModified ?? 0));
    const recentCount = Math.floor(opts.sampleSize / 2);
    const recent = notes.slice(0, recentCount);
    const rest = notes.slice(recentCount);
    const randomCount = opts.sampleSize - recentCount;
    const shuffled = rest.slice();
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1);
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return sampleHasNoTerm([...recent, ...shuffled.slice(0, randomCount)]);
}

function filterIndexFiles(results: { file: string; score: number }[]): string[] {
    return results
        .map((r) => r.file)
        .filter((f) => f.endsWith('.md') && !f.startsWith('Library/'));
}

async function indexSearch(opts: {
    ctx: SearchContext;
    query: string;
    searchType: 'content' | 'title' | 'both';
    caseSensitive: boolean;
    maxResults: number;
    page: number;
    mode: 'auto' | 'index';
    useRegex: boolean;
    validateSampleSize: number;
    concise: boolean;
    contextLines: number;
    indexResults?: { file: string; score: number }[];
}): Promise<HybridSearchOutcome | { scan: true; notice?: string }> {
    const { ctx, mode } = opts;
    const caps = ctx.caps;

    // 1. Which engine? Fresh cached verdict or probe.
    let engine: string | null = null;
    const cached = caps.get();
    if (cached && cached.available === true && cached.engine) {
        engine = cached.engine;
    } else if (cached && cached.available === false) {
        if (mode === 'index') throw new Error('Runtime API or search library unavailable (cached verdict)');
        return { scan: true }; // known-negative → scan without probing
    } else {
        const probe = await ctx.runtime.probeCapabilities();
        if (!probe.ok) {
            caps.save({ available: false });
            if (mode === 'index') throw new Error(`Runtime API unavailable: ${probe.error ?? 'unknown error'}`);
            return { scan: true };
        }
        if (probe.caps?.basicSearch) engine = 'basic';
        else if (probe.caps?.silversearch) engine = 'silver';
        if (!engine) {
            caps.save({ available: false });
            if (mode === 'index') {
                throw new Error('No full-text search library installed (install silversearch or basic-search)');
            }
            return { scan: true };
        }
        caps.save({ available: true, engine });
    }

    // 2. Search via the engine.
    let searchOut;
    if (opts.indexResults) {
        searchOut = { ok: true as const, results: opts.indexResults };
    } else {
        searchOut = await ctx.runtime.fulltextSearch(opts.query, engine);
    }
    if (!searchOut.ok) {
        // The verdict said "available" but the search failed — the index may
        // be stale or the library broken. Invalidate and fall back.
        caps.clear();
        if (mode === 'index') throw new Error(`Index search failed: ${searchOut.error}`);
        return { scan: true, notice: `index search failed (${searchOut.error}); used full scan instead` };
    }

    const files = filterIndexFiles(searchOut.results ?? []);

    // 3. Zero-result validation.
    if (files.length === 0) {
        const trusted = await validateZeroResults({
            ctx,
            query: opts.query,
            caseSensitive: opts.caseSensitive,
            sampleSize: opts.validateSampleSize,
        });
        if (!trusted) {
            return {
                scan: true,
                notice: 'index returned no results but the term exists in notes; used full scan instead',
            };
        }
        return finish({ results: [], maxResults: opts.maxResults, page: opts.page, source: 'index' });
    }

    // 4. Paginate server-side results; fetch only the current page's notes.
    const start = (opts.page - 1) * opts.maxResults;
    const window = files.slice(start, start + opts.maxResults);
    const results = await extractLines({
        ctx,
        files: window,
        query: opts.query,
        searchType: opts.searchType,
        caseSensitive: opts.caseSensitive,
        useRegex: opts.useRegex,
        concise: opts.concise,
        contextLines: opts.contextLines,
    });
    return finish({
        results,
        maxResults: opts.maxResults,
        page: opts.page,
        source: 'index',
        totalOverride: files.length,
    });
}

export async function hybridSearch(opts: HybridSearchOptions): Promise<HybridSearchOutcome> {
    const searchType = opts.searchType ?? 'both';
    const mode = opts.mode ?? 'auto';
    const maxResults = opts.maxResults ?? 10;
    const page = Math.max(1, opts.page ?? 1);
    const concise = opts.concise ?? true;
    const contextLines = opts.contextLines ?? 1;
    const useRegex = opts.useRegex ?? true;

    // Title search: the libraries don't search titles/filenames — always scan.
    if (searchType === 'title' || mode === 'scan') {
        return scanSearch({
            ctx: opts.ctx,
            query: opts.query,
            searchType,
            caseSensitive: !!opts.caseSensitive,
            useRegex,
            maxResults,
            page,
            concise,
            contextLines,
        });
    }

    const attempt = await indexSearch({
        ctx: opts.ctx,
        query: opts.query,
        searchType,
        caseSensitive: !!opts.caseSensitive,
        maxResults,
        page,
        mode,
        useRegex,
        validateSampleSize: 10,
        concise,
        contextLines,
        indexResults: opts.indexResults,
    });

    if (attempt && !('scan' in attempt)) {
        return attempt;
    }

    const out = await scanSearch({
        ctx: opts.ctx,
        query: opts.query,
        searchType,
        caseSensitive: !!opts.caseSensitive,
        useRegex,
        maxResults,
        page,
        concise,
        contextLines,
    });
    if (attempt && 'notice' in attempt && attempt.notice) out.notice = attempt.notice;
    return out;
}
