const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startHarness } = require('./helpers/harness.cjs');

test('HTTP MCP baseline against disposable SilverBullet fixture', async t => {
  const h = await startHarness(t);
  await t.test('rejects missing and incorrect credentials', async () => {
    for (const token of [null, 'wrong']) assert.equal((await h.rpc('tools/list', {}, null, token)).status, 401);
  });
  const first = await h.initialize();
  const second = await h.initialize();
  await t.test('independent sessions expose expected tools', async () => {
    assert.notEqual(first, second);
    const result = await h.rpc('tools/list', {}, first);
    assert.equal(result.status, 200);
    assert.ok(result.json.result.tools.some(tool => tool.name === 'search-replace-note'));
  });
  await t.test('reads a nested filename through the API', async () => {
    const result = await h.rpc('tools/call', { name: 'read-note', arguments: { filename: 'Folder/Space note.md' } }, first);
    assert.equal(result.json.result.isError, undefined);
    assert.match(JSON.stringify(result.json.result), /nested content/);
    assert.ok(h.requests.some(r => r.url.includes('Folder%2FSpace%20note.md')));
  });
  await t.test('replaces plain text and persists the result', async () => {
    const result = await h.rpc('tools/call', { name: 'search-replace-note', arguments: { filename: 'Test.md', searchPattern: 'hello', replaceText: 'goodbye' } }, first);
    assert.equal(result.json.result.isError, undefined);
    assert.equal(h.notes.get('Test.md'), 'goodbye world');
  });
  await t.test('reads a resource directly', async () => {
    const result = await h.rpc('resources/read', { uri: 'sb-note://Test.md' }, first);
    assert.equal(result.json.result.contents[0].text, 'goodbye world');
  });
  await t.test('reports missing notes as tool errors', async () => {
    const result = await h.rpc('tools/call', { name: 'read-note', arguments: { filename: 'missing.md' } }, first);
    assert.equal(result.json.result.isError, true);
  });
  await t.test('terminating one session preserves the other', async () => {
    assert.equal((await h.rpc(null, {}, first, 'fixture-mcp-token', 'DELETE')).status, 200);
    assert.equal((await h.rpc('tools/list', {}, second)).status, 200);
    assert.ok((await h.rpc('tools/list', {}, first)).status >= 400);
  });
});

test('configured space path prefix reaches every API operation', async t => {
  const h = await startHarness(t, '/work');
  const session = await h.initialize();
  const result = await h.rpc('tools/call', { name: 'search-replace-note', arguments: { filename: 'Test.md', searchPattern: 'hello', replaceText: 'space' } }, session);
  assert.equal(result.json.result.isError, undefined);
  assert.equal(h.notes.get('Test.md'), 'space world');
  await h.rpc('tools/call', { name: 'list-notes', arguments: {} }, session);
  await h.rpc('tools/call', { name: 'delete-note', arguments: { filename: 'Test.md' } }, session);
  assert.equal(h.notes.has('Test.md'), false);
  assert.ok(h.requests.length >= 4);
  assert.ok(h.requests.every(r => r.url.startsWith('/work/.fs')));
});

test('resource discovery is paginated, complete, and shares the listing cache', async t => {
  const h = await startHarness(t);
  h.notes.clear();
  for (let i = 0; i < 205; i++) h.notes.set(`Folder/Note ${i}.md`, 'content');
  const session = await h.initialize();
  const names = [];
  let cursor;
  do {
    const result = await h.rpc('resources/list', cursor ? { cursor } : {}, session);
    assert.equal(result.status, 200);
    assert.ok(result.json.result.resources.length <= 100);
    names.push(...result.json.result.resources.map(note => note.name));
    cursor = result.json.result.nextCursor;
  } while (cursor);
  assert.deepEqual(names, [...h.notes.keys()].sort());
  assert.equal(h.requests.filter(r => r.url === '/.fs').length, 1);
  const invalid = await h.rpc('resources/list', { cursor: '!!!' }, session);
  assert.equal(invalid.json.error.code, -32602);
});

test('session protocol errors are recoverable and preserve request id zero', async t => {
  const h = await startHarness(t);
  for (const method of ['POST', 'GET', 'DELETE']) {
    assert.equal((await h.rpc('tools/list', {}, undefined, 'fixture-mcp-token', method)).status, 400);
    for (const id of ['unknown', '__proto__', 'constructor']) {
      assert.equal((await h.rpc('tools/list', {}, id, 'fixture-mcp-token', method)).status, 404);
    }
  }
  const invalid = await fetch(`${h.base}/mcp`, { method: 'POST', headers: {
    Authorization: 'Bearer fixture-mcp-token', 'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  }, body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'tools/list' }) });
  assert.equal((await invalid.json()).id, 0);
  const badInit = await h.rpc('initialize', { protocolVersion: '2025-03-26' });
  assert.equal(badInit.status, 400);
  const session = await h.initialize();
  assert.equal((await h.rpc('tools/list', {}, session)).status, 200);
  assert.equal((await h.rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } }, 'unknown')).status, 404);
});

test('SSE disconnect leaves a session usable and reconnectable', async t => {
  const h = await startHarness(t);
  const session = await h.initialize();
  for (let i = 0; i < 2; i++) {
    const controller = new AbortController();
    const response = await fetch(`${h.base}/mcp`, { headers: {
      Authorization: 'Bearer fixture-mcp-token', Accept: 'text/event-stream', 'mcp-session-id': session,
    }, signal: controller.signal });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/event-stream/);
    await response.body.cancel(); controller.abort();
    assert.equal((await h.rpc('tools/list', {}, session)).status, 200);
  }
});

test('SIGTERM closes active SSE sessions and exits cleanly', async t => {
  const { once } = require('node:events');
  const h = await startHarness(t);
  const session = await h.initialize();
  const response = await fetch(`${h.base}/mcp`, { headers: {
    Authorization: 'Bearer fixture-mcp-token', Accept: 'text/event-stream', 'mcp-session-id': session,
  } });
  const exited = once(h.child, 'exit');
  h.child.kill('SIGTERM');
  let timeout;
  try {
    const [code, signal] = await Promise.race([exited, new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error('shutdown timeout')), 5000);
    })]);
    assert.equal(code, 0);
    assert.equal(signal, null);
    await response.text();
  } finally { clearTimeout(timeout); }
});
