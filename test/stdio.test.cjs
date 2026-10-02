const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { startStdioHarness } = require('./helpers/harness.cjs');

test('stdio transport keeps stdout protocol-clean and exposes the same tools', async t => {
  const h = await startStdioHarness(t);
  const initialized = await h.initialize();
  assert.equal(initialized.result.serverInfo.name, 'SilverBullet MCP');
  const listed = await h.rpc('tools/list');
  const names = listed.result.tools.map(tool => tool.name).sort();
  assert.deepEqual(names, [
    'create-note', 'delete-note', 'edit-note', 'list-notes',
    'read-multiple-notes', 'read-note', 'search-notes', 'search-replace-note',
  ]);
  assert.deepEqual(h.stdoutNoise, [], 'stdout is the MCP channel and must stay pure JSON-RPC');
});

test('stdio note operations reach the SilverBullet API and persist', async t => {
  const h = await startStdioHarness(t);
  await h.initialize();
  const read = await h.rpc('tools/call', { name: 'read-note', arguments: { filename: 'Test.md' } });
  assert.equal(read.result.isError, undefined);
  assert.match(read.result.structuredContent.content, /hello world/);
  const replaced = await h.rpc('tools/call', { name: 'search-replace-note', arguments: { filename: 'Test.md', searchPattern: 'hello', replaceText: 'goodbye' } });
  assert.equal(replaced.result.isError, undefined);
  assert.equal(h.notes.get('Test.md'), 'goodbye world');
  const resource = await h.rpc('resources/read', { uri: 'sb-note://Test.md' });
  assert.equal(resource.result.contents[0].text, 'goodbye world');
  const missing = await h.rpc('tools/call', { name: 'read-note', arguments: { filename: 'missing.md' } });
  assert.equal(missing.result.isError, true);
  assert.deepEqual(h.stdoutNoise, [], 'reads must not write to stdout, which is the MCP channel');
});

test('stdio server starts without MCP_TOKEN because no port is exposed', async t => {
  const h = await startStdioHarness(t);
  await h.initialize();
  const listed = await h.rpc('tools/list');
  assert.ok(listed.result.tools.length > 0);
});

test('ending stdin shuts the stdio process down cleanly', async t => {
  const h = await startStdioHarness(t);
  await h.initialize();
  const exited = once(h.child, 'exit');
  h.child.stdin.end();
  const [code, signal] = await exited;
  assert.equal(code, 0);
  assert.equal(signal, null);
});
