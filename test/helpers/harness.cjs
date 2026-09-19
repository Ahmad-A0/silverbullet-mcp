const { createServer } = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const path = require('node:path');
const { createHash } = require('node:crypto');
const revision = text => `"sha256:${createHash('sha256').update(text).digest('hex')}"`;
const target = path.resolve(process.env.TEST_TARGET_DIR || path.join(__dirname, '../..'));

async function startHarness(t, prefix = '', external = {}) {
  const notes = new Map([['Test.md', 'hello world'], ['Folder/Space note.md', 'nested content']]);
  let modified = 1;
  const requests = [];
  const controls = { etags: true, readStatus: null, beforeWrite: null };
  const backend = createServer(async (req, res) => {
    requests.push({ method: req.method, url: req.url, ifMatch: req.headers['if-match'], ifNoneMatch: req.headers['if-none-match'] });
    if (req.headers.authorization !== 'Bearer fixture-sb-token') {
      res.writeHead(401).end(); return;
    }
    if (req.url === `${prefix}/.fs`) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify([...notes].map(([name, content]) => ({ name, perm: 'rw', lastModified: modified, size: content.length, contentType: 'text/markdown' }))));
      return;
    }
    if (!req.url.startsWith(`${prefix}/.fs/`)) { res.writeHead(404).end(); return; }
    const name = decodeURIComponent(req.url.slice(`${prefix}/.fs/`.length));
    if (req.method === 'PUT') {
      let body = ''; for await (const chunk of req) body += chunk;
      controls.beforeWrite?.(name, notes);
      if ((req.headers['if-match'] && (!notes.has(name) || req.headers['if-match'] !== revision(notes.get(name)))) || (req.headers['if-none-match'] === '*' && notes.has(name))) { res.writeHead(412).end('Precondition Failed'); return; }
      notes.set(name, body); modified++;
      if (controls.etags) res.setHeader('ETag', revision(body));
      res.end();
    } else if (req.method === 'DELETE') {
      notes.delete(name); modified++; res.end();
    } else if (controls.readStatus) res.writeHead(controls.readStatus).end('Read failed');
    else if (notes.has(name)) {
      if (controls.etags) res.setHeader('ETag', revision(notes.get(name)));
      res.end(notes.get(name));
    }
    else res.writeHead(404).end('Missing note');
  });
  await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
  t.after(() => { backend.closeAllConnections(); backend.close(); });
  const reservation = createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const child = spawn(process.execPath, [path.join(target, 'dist/server.js')], {
    cwd: target,
    env: { PATH: process.env.PATH, PORT: String(port), MCP_TOKEN: 'fixture-mcp-token', SB_AUTH_TOKEN: external.token || 'fixture-sb-token', SB_API_BASE_URL: external.url || `http://127.0.0.1:${backend.address().port}${prefix}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', chunk => { logs = (logs + chunk).slice(-16000); });
  child.stderr.on('data', chunk => { logs = (logs + chunk).slice(-16000); });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    }
  });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(logs);
    try { if ((await fetch(base, { signal: AbortSignal.timeout(300) })).ok) break; } catch {}
    if (Date.now() >= deadline) throw new Error(`Server startup timed out: ${logs}`);
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  let id = 0;
  async function rpc(method, params = {}, session, token = 'fixture-mcp-token', verb = 'POST') {
    const headers = { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (session) headers['mcp-session-id'] = session;
    const response = await fetch(`${base}/mcp`, { method: verb, headers, signal: AbortSignal.timeout(5000), ...(verb === 'POST' ? { body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) } : {}) });
    const body = await response.text();
    const data = body.split('\n').find(line => line.startsWith('data: '));
    let json; try { json = JSON.parse(data ? data.slice(6) : body); } catch {}
    return { status: response.status, json, body, session: response.headers.get('mcp-session-id') };
  }
  async function initialize() {
    const result = await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'repo-test', version: '1' } });
    if (result.status !== 200 || !result.session) throw new Error(result.body);
    return result.session;
  }
  return { notes, requests, rpc, initialize, base, child, controls };
}
module.exports = { startHarness, target };
