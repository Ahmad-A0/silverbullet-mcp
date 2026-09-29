/**
 * SilverBullet Runtime API client.
 *
 * The Runtime API (POST /.runtime/lua_script) evaluates Lua in a headless
 * Chrome client hosted by the server. All syscall namespaces are exposed as
 * Lua globals there, which makes installed search libraries callable:
 *   - basic-search:  search.ftsSearch(phrase)  -> [{id: pageName, score}]
 *   - silversearch:  silversearch.search(term) -> [{name: pageName, score, ...}]
 * Responses use a {"result": ...} / {"error": msg} envelope.
 */

export interface RuntimeProbe {
    ok: true;
    caps: { basicSearch: boolean; silversearch: boolean; query: boolean };
}

export interface RuntimeFailure {
    ok: false;
    kind: 'unavailable' | 'auth' | 'error' | 'timeout';
    error: string;
}

export type RuntimeProbeResult = RuntimeProbe | RuntimeFailure;
export type RuntimeSearchResult =
    | { ok: true; results: { file: string; score: number }[] }
    | { ok: false; error: string };

export interface RuntimeClient {
    probeCapabilities(timeoutMs?: number): Promise<RuntimeProbeResult>;
    fulltextSearch(term: string, engine: 'basic' | 'silver', timeoutMs?: number): Promise<RuntimeSearchResult>;
}

const PROBE_LUA = [
    'local caps = {}',
    'caps.basicSearch = type(search) == "table" and type(search.ftsSearch) == "function"',
    'caps.silversearch = type(silversearch) == "table" and type(silversearch.search) == "function"',
    'caps.query = type(query) == "function"',
    'return caps',
].join('\n');

export function luaEscape(s: string): string {
    return String(s)
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "\\'")
        .replace(/\r/g, '\\r')
        .replace(/\n/g, '\\n')
        .replace(/\0/g, '\\0');
}

function classify(res: Response, bodyText: string): RuntimeFailure | { ok: true; result: unknown } {
    if (res.status === 401 || (res.status >= 300 && res.status < 400)) {
        return { ok: false, kind: 'auth', error: 'authentication required' };
    }
    if (res.status === 404 || res.status === 405) {
        return { ok: false, kind: 'unavailable', error: `runtime API not available (HTTP ${res.status})` };
    }
    let data: { result?: unknown; error?: unknown } | null = null;
    try {
        data = JSON.parse(bodyText);
    } catch {
        return { ok: false, kind: 'error', error: `malformed runtime response (HTTP ${res.status})` };
    }
    if (data && typeof data.error === 'string') {
        return { ok: false, kind: 'error', error: data.error };
    }
    return { ok: true, result: data ? data.result : null };
}

export function createRuntimeClient(baseUrl: string, authToken?: string): RuntimeClient {
    const base = baseUrl.replace(/\/+$/, '');

    async function evalScript(code: string, timeoutMs = 30000) {
        let res: Response;
        try {
            res = await fetch(`${base}/.runtime/lua_script`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'text/plain',
                    'X-Timeout': String(Math.max(1, Math.ceil(timeoutMs / 1000))),
                    ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
                },
                body: code,
                signal: AbortSignal.timeout(timeoutMs),
            });
        } catch (e) {
            const name = e instanceof Error ? e.name : '';
            const kind: 'timeout' | 'unavailable' =
                name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'unavailable';
            return { ok: false as const, kind, error: e instanceof Error ? e.message : String(e) };
        }
        const text = await res.text();
        return classify(res, text);
    }

    async function probeCapabilities(timeoutMs = 30000): Promise<RuntimeProbeResult> {
        const out = await evalScript(PROBE_LUA, timeoutMs);
        if (!out.ok) return out;
        const caps = out.result as { basicSearch?: unknown; silversearch?: unknown } | null;
        if (
            !caps ||
            typeof caps !== 'object' ||
            typeof caps.basicSearch !== 'boolean' ||
            typeof caps.silversearch !== 'boolean'
        ) {
            return { ok: false, kind: 'error', error: 'unexpected probe response shape' };
        }
        return {
            ok: true,
            caps: {
                basicSearch: caps.basicSearch as boolean,
                silversearch: caps.silversearch as boolean,
                query: (caps as { query?: unknown }).query === true,
            },
        };
    }

    async function fulltextSearch(
        term: string,
        engine: 'basic' | 'silver',
        timeoutMs = 60000
    ): Promise<RuntimeSearchResult> {
        let code: string;
        if (engine === 'basic') {
            code = `return search.ftsSearch('${luaEscape(term)}')`;
        } else if (engine === 'silver') {
            code = `return silversearch.search('${luaEscape(term)}', {silent = true})`;
        } else {
            return { ok: false, error: `unknown search engine: ${engine}` };
        }
        const out = await evalScript(code, timeoutMs);
        if (!out.ok) {
            return { ok: false, error: 'error' in out ? out.error : 'runtime request failed' };
        }
        const rows = Array.isArray(out.result) ? out.result : [];
        const results = rows
            .map((r) => {
                const row = r as { id?: unknown; name?: unknown; score?: unknown };
                const name = engine === 'basic' ? row?.id : row?.name;
                if (typeof name !== 'string' || name.length === 0) return null;
                const file = name.endsWith('.md') ? name : `${name}.md`;
                return { file, score: typeof row.score === 'number' ? row.score : 0 };
            })
            .filter((r): r is { file: string; score: number } => r !== null)
            .sort((a, b) => b.score - a.score);
        return { ok: true, results };
    }

    return { probeCapabilities, fulltextSearch };
}
