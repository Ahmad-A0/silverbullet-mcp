// Creates and destroys its own real SilverBullet server; never uses .env or user data.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { startHarness } = require('../helpers/harness.cjs');

test('SilverBullet 2.11: authenticated multi-space CRUD through MCP', { timeout: 120000 }, async t => {
  const runtime = process.env.CONTAINER_RUNTIME || 'docker';
  const name = `silverbullet-mcp-test-${randomUUID()}`;
  const image = 'ghcr.io/silverbulletmd/silverbullet:2.11.0-slim';
  execFileSync(runtime, ['run', '-d', '--name', name, '-p', '127.0.0.1::3000', '--tmpfs', '/data:rw', image], { timeout: 90000 });
  t.after(() => execFileSync(runtime, ['rm', '-f', name], { timeout: 15000 }));
  const address = execFileSync(runtime, ['port', name, '3000'], { encoding: 'utf8' }).trim();
  const base = `http://${address}`;
  for (let n = 0; ; n++) {
    try { if ((await fetch(`${base}/.setup/api/status`)).ok) break; } catch {}
    if (n > 100) throw new Error('SilverBullet startup timeout');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const password = randomUUID();
  async function post(path, body, cookie) {
    const response = await fetch(`${base}${path}`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
    assert.equal(response.status, 200, await response.clone().text());
    return response;
  }
  await post('/.setup/api/complete', { adminUsername: 'testadmin', adminPassword: password,
    primaryUrl: base, space: { name: 'Work', prefix: '/work', folder: '', revisions: 'unmanaged' } });
  for (let n = 0; ; n++) {
    const ready = await fetch(`${base}/.dashboard/api/session`, { redirect: 'manual' });
    if (ready.status === 401) break;
    if (n > 100) throw new Error('SilverBullet setup did not switch to multi-space mode');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const login = await post('/.dashboard/api/login', { username: 'testadmin', password });
  const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  const { token } = await (await post('/.dashboard/api/admin/users/testadmin/tokens', { name: 'mcp-test' }, cookie)).json();
  assert.ok(token);
  await post('/.dashboard/api/admin/users', { username: 'reader', password: randomUUID() }, cookie);
  await post('/.dashboard/api/admin/spaces', { name: 'Other', binding: { prefix: '/other' }, revisions: 'unmanaged', members: { reader: { role: 'read' } } }, cookie);
  const { token: readerToken } = await (await post('/.dashboard/api/admin/users/reader/tokens', { name: 'read-test' }, cookie)).json();
  const h = await startHarness(t, '', { url: `${base}/work/`, token });
  const session = await h.initialize();
  async function tool(name, args) {
    const result = await h.rpc('tools/call', { name, arguments: args }, session);
    assert.equal(result.status, 200);
    assert.ok(!result.json.result.isError, JSON.stringify(result.json));
    return result.json.result;
  }
  const filename = 'Folder/MCP test.md';
  await tool('create-note', { filename, content: 'before hello after' });
  const otherWrite = await fetch(`${base}/other/.fs/${encodeURIComponent(filename)}`, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/markdown', 'X-Sync-Mode': 'true' }, body: 'different space' });
  assert.equal(otherWrite.status, 200);
  const reader = await startHarness(t, '', { url: `${base}/other`, token: readerToken });
  const readerSession = await reader.initialize();
  const otherRead = await reader.rpc('tools/call', { name: 'read-note', arguments: { filename } }, readerSession);
  assert.match(JSON.stringify(otherRead.json.result), /different space/);
  const denied = await reader.rpc('tools/call', { name: 'search-replace-note', arguments: { filename, searchPattern: 'different', replaceText: 'changed' } }, readerSession);
  assert.equal(denied.json.result.isError, true);
  assert.notEqual((await fetch(`${base}/work/.fs`, { headers: { Authorization: `Bearer ${readerToken}` }, redirect: 'manual' })).status, 200);
  assert.match(JSON.stringify(await tool('list-notes', {})), /MCP test/);
  assert.match(JSON.stringify(await tool('read-note', { filename })), /before hello after/);
  await tool('search-replace-note', { filename, searchPattern: 'hello', replaceText: "$& $$ $'" });
  assert.match(JSON.stringify(await tool('read-note', { filename })), /before \$& \$\$ \$' after/);
  const resource = await h.rpc('resources/read', { uri: `sb-note://${encodeURIComponent(filename)}` }, session);
  assert.equal(resource.json.result.contents[0].text, "before $& $$ $' after");
  const editArgs = { filename, edits: [{ oldText: 'before', newText: 'updated' }] };
  const preview = (await tool('edit-note', { ...editArgs, dryRun: true })).structuredContent;
  assert.equal(preview.applied, false);
  assert.ok(preview.revision);
  const applied = (await tool('edit-note', { ...editArgs, expectedRevision: preview.revision })).structuredContent;
  assert.equal(applied.applied, true);
  assert.notEqual(applied.revision, preview.revision);
  const stale = await h.rpc('tools/call', { name: 'edit-note', arguments: {
    filename, edits: [{ oldText: 'updated', newText: 'stale' }], expectedRevision: preview.revision,
  } }, session);
  assert.equal(stale.json.result.isError, true);
  const rejected = await fetch(`${base}/work/.fs/${encodeURIComponent(filename)}`, { method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'If-Match': preview.revision, 'Content-Type': 'text/markdown' }, body: 'stale write' });
  assert.equal(rejected.status, 412, 'real SilverBullet rejects stale conditional writes');
  assert.match((await tool('read-note', { filename })).structuredContent.content, /^updated/);
  const editDenied = await reader.rpc('tools/call', { name: 'edit-note', arguments: {
    filename, edits: [{ oldText: 'different', newText: 'changed' }],
  } }, readerSession);
  assert.equal(editDenied.json.result.isError, true);
  await tool('delete-note', { filename });
  const missing = await h.rpc('tools/call', { name: 'read-note', arguments: { filename } }, session);
  assert.equal(missing.json.result.isError, true);
  assert.notEqual((await fetch(`${base}/work/.fs`, { headers: { Authorization: 'Bearer wrong-token' }, redirect: 'manual' })).status, 200);
  assert.equal((await fetch(`${base}/.fs`, { headers: { Authorization: `Bearer ${token}` }, redirect: 'manual' })).status, 404);
});
