const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { startHarness, target } = require('../helpers/harness.cjs');

test('PR14: replacement dollar sequences must remain literal through the actual tool', async t => {
  const h = await startHarness(t);
  const session = await h.initialize();
  for (const replacement of ['$&', "$'", '$`', '$$', '$1']) {
    h.notes.set('Test.md', 'before hello after');
    const result = await h.rpc('tools/call', { name: 'search-replace-note', arguments: { filename: 'Test.md', searchPattern: 'hello', replaceText: replacement } }, session);
    assert.equal(result.json.result.isError, undefined);
    assert.equal(h.notes.get('Test.md'), `before ${replacement} after`);
  }
});

test('PR16: terminated session returns 404 so clients know to reinitialize', async t => {
  const h = await startHarness(t);
  const session = await h.initialize();
  await h.rpc(null, {}, session, 'fixture-mcp-token', 'DELETE');
  assert.equal((await h.rpc('tools/list', {}, session)).status, 404);
});

test('PR15: a listing started before a write cannot repopulate the cache after invalidation', async t => {
  const api = require(path.join(target, 'dist/silverbullet-api.js'));
  let release;
  let started;
  const began = new Promise(resolve => { started = resolve; });
  const delayed = new Promise(resolve => { release = resolve; });
  let listings = 0;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    if (options?.method === 'PUT') return new Response(null, { status: 200 });
    listings++;
    if (listings === 1) { started(); await delayed; return Response.json([{ name: 'Old.md', perm: 'rw' }]); }
    return Response.json([{ name: 'New.md', perm: 'rw' }]);
  });
  const pending = api.listNotesAPI();
  await began;
  await api.writeNoteAPI('New.md', 'new');
  release();
  await pending;
  assert.deepEqual((await api.listNotesAPI()).map(note => note.name), ['New.md']);
});
