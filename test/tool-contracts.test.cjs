const { test } = require('node:test');
const assert = require('node:assert/strict');
const Ajv = require('ajv');
const { startHarness } = require('./helpers/harness.cjs');

async function setup(t) {
  const h = await startHarness(t);
  const session = await h.initialize();
  const listed = await h.rpc('tools/list', {}, session);
  const ajv = new Ajv({ strict: false });
  const validators = new Map(listed.json.result.tools.map(tool => {
    assert.ok(tool.outputSchema, `${tool.name} has an output schema`);
    return [tool.name, ajv.compile(tool.outputSchema)];
  }));
  async function call(name, args, error = false) {
    const response = await h.rpc('tools/call', { name, arguments: args }, session);
    const result = response.json.result;
    assert.ok(result, JSON.stringify(response.json));
    if (error) assert.equal(result.isError, true, JSON.stringify(result));
    else {
      assert.ok(!result.isError, JSON.stringify(result));
      const valid = validators.get(name);
      assert.ok(valid(result.structuredContent), `${name}: ${JSON.stringify(valid.errors)}`);
      assert.equal(result.content[0].type, 'text');
    }
    return result;
  }
  return { ...h, call };
}

test('edit-note previews and applies multiple original-snapshot edits with literal replacements', async t => {
  const h = await setup(t);
  const original = 'First: alpha\r\nSecond: beta\r\n';
  h.notes.set('Test.md', original);
  const args = { filename: 'Test.md', edits: [
    { oldText: 'alpha', newText: 'beta' },
    { oldText: 'beta', newText: "$& $$ $' $` $1" },
  ] };
  const preview = (await h.call('edit-note', { ...args, dryRun: true })).structuredContent;
  assert.equal(preview.applied, false);
  assert.match(preview.diff, /-First: alpha/);
  assert.equal(h.notes.get('Test.md'), original);
  assert.equal(h.requests.filter(r => r.method === 'PUT').length, 0);
  const applied = (await h.call('edit-note', { ...args, expectedRevision: preview.revision })).structuredContent;
  assert.equal(applied.applied, true);
  assert.equal(h.notes.get('Test.md'), "First: beta\r\nSecond: $& $$ $' $` $1\r\n");
  assert.notEqual(applied.revision, preview.revision);
  const writes = h.requests.filter(r => r.method === 'PUT');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].ifMatch, preview.revision);
});

test('bad, ambiguous, overlapping, stale, and unsupported edits never write', async t => {
  const h = await setup(t);
  h.notes.set('Test.md', 'hello hello');
  for (const edits of [
    [{ oldText: 'hello', newText: 'x' }],
    [{ oldText: 'hello', newText: 'x', expectedMatches: 2 }, { oldText: 'absent', newText: 'x' }],
    [{ oldText: 'hello hello', newText: 'x' }, { oldText: 'hello', newText: 'x', expectedMatches: 2 }],
    [{ oldText: 'Hello', newText: 'x' }],
    [{ oldText: '', newText: 'x' }],
  ]) {
    await h.call('edit-note', { filename: 'Test.md', edits }, true);
    assert.equal(h.notes.get('Test.md'), 'hello hello');
  }
  const read = (await h.call('read-note', { filename: 'Test.md' })).structuredContent;
  h.notes.set('Test.md', 'new content');
  await h.call('edit-note', { filename: 'Test.md', expectedRevision: read.revision,
    edits: [{ oldText: 'new', newText: 'old' }] }, true);
  h.controls.etags = false;
  await h.call('edit-note', { filename: 'Test.md', edits: [{ oldText: 'new', newText: 'old' }] }, true);
  assert.equal(h.requests.filter(r => r.method === 'PUT').length, 0);
});

test('write-time revision conflict preserves a concurrent external change', async t => {
  const h = await setup(t);
  h.controls.beforeWrite = (name, notes) => notes.set(name, 'external update');
  const result = await h.call('edit-note', { filename: 'Test.md', edits: [{ oldText: 'hello', newText: 'hi' }] }, true);
  assert.match(result.content[0].text, /Revision conflict/);
  assert.equal(h.notes.get('Test.md'), 'external update');
});

test('explicit match counts work and unchanged edits skip writes', async t => {
  const h = await setup(t);
  h.notes.set('Test.md', 'same same');
  const same = (await h.call('edit-note', { filename: 'Test.md', edits: [{ oldText: 'same', newText: 'same', expectedMatches: 2 }] })).structuredContent;
  assert.equal(same.applied, false);
  assert.equal(same.changed, false);
  assert.equal(h.requests.filter(r => r.method === 'PUT').length, 0);
  const changed = (await h.call('edit-note', { filename: 'Test.md', edits: [{ oldText: 'same', newText: '', expectedMatches: 2 }] })).structuredContent;
  assert.deepEqual(changed.replacements, [2]);
  assert.equal(h.notes.get('Test.md'), ' ');
});

test('read, list, search, batch, create, delete and legacy replacement return valid structured results', async t => {
  const h = await setup(t);
  let read = (await h.call('read-note', { filename: 'Test.md', limit: 5 })).structuredContent;
  assert.equal(read.content, 'hello'); assert.equal(read.nextOffset, 5);
  read = (await h.call('read-note', { filename: 'Test.md', offset: 5 })).structuredContent;
  assert.equal(read.content, ' world'); assert.equal(read.nextOffset, null);
  const list = (await h.call('list-notes', { limit: 1 })).structuredContent;
  assert.equal(list.notes.length, 1); assert.ok(list.nextCursor);
  const next = (await h.call('list-notes', { limit: 1, cursor: list.nextCursor })).structuredContent;
  assert.notEqual(list.notes[0].name, next.notes[0].name); assert.equal(next.nextCursor, null);
  await h.call('list-notes', { namePattern: '^absent' });
  const batch = (await h.call('read-multiple-notes', { filenames: ['Test.md'], contentLimit: 3 })).structuredContent;
  assert.equal(batch.notes[0].content, 'hel'); assert.equal(batch.notes[0].truncated, true);
  const summary = (await h.call('read-multiple-notes', { filenames: ['Test.md'], format: 'summary', contentLimit: 3 })).structuredContent;
  assert.equal(summary.notes[0].contentPreview, 'hel');
  assert.equal(summary.notes[0].truncated, true);
  await h.call('read-multiple-notes', { namePattern: '^absent' });
  const partial = (await h.call('read-multiple-notes', { filenames: ['missing.md', 'Test.md'] })).structuredContent;
  assert.equal(partial.summary.errorCount, 1);
  await h.call('search-notes', { query: 'hello' });
  await h.call('search-notes', { query: '[' , useRegex: false });
  const replaced = (await h.call('search-replace-note', { filename: 'Test.md', searchPattern: '(hello)', replaceText: 'HELLO', useRegex: true, replaceAll: false })).structuredContent;
  assert.equal(replaced.replacements, 1, 'capture groups are not replacements');
  await h.call('search-replace-note', { filename: 'Test.md', searchPattern: 'absent', replaceText: '' });
  await h.call('create-note', { filename: 'New.md', content: 'new' });
  await h.call('delete-note', { filename: 'New.md' });
});

test('invalid patterns and limits are explicit tool errors', async t => {
  const h = await setup(t);
  for (const [name, args] of [
    ['search-replace-note', { filename: 'Test.md', searchPattern: '[', replaceText: 'x', useRegex: true }],
    ['search-notes', { query: '[' }], ['search-notes', { query: 'hello', page: 0 }],
    ['search-notes', { query: 'hello', maxResults: 0.5 }],
    ['list-notes', { limit: 0 }], ['list-notes', { cursor: '!' }],
    ['read-note', { filename: 'Test.md', offset: -1 }],
    ['read-multiple-notes', { namePattern: '[' }],
    ['edit-note', { filename: 'Test.md', edits: [{ oldText: 'hello', newText: 'hi' }], dryrun: true }],
    ['edit-note', { filename: 'Test.md', edits: [{ oldText: 'hello', newText: 'hi', expectedMatch: 2 }] }],
  ]) await h.call(name, args, true);
  assert.equal(h.requests.filter(r => r.method === 'PUT').length, 0);
});

test('create-note stops on read errors and cannot overwrite a racing create', async t => {
  const h = await setup(t);
  h.controls.readStatus = 403;
  await h.call('create-note', { filename: 'New.md', content: 'new' }, true);
  assert.equal(h.requests.filter(r => r.method === 'PUT').length, 0);
  h.controls.readStatus = null;
  h.controls.beforeWrite = (name, notes) => notes.set(name, 'external create');
  await h.call('create-note', { filename: 'New.md', content: 'new' }, true);
  assert.equal(h.notes.get('New.md'), 'external create');
  assert.equal(h.requests.find(r => r.method === 'PUT').ifNoneMatch, '*');
});

test('search results bound match snippets and report failed reads', async t => {
  const h = await setup(t);
  h.notes.set('Test.md', Array.from({ length: 30 }, () => `hello ${'x'.repeat(2500)}`).join('\n'));
  const found = (await h.call('search-notes', { query: 'hello', maxMatchesPerNote: 2, concise: false })).structuredContent;
  assert.equal(found.results[0].score, 30);
  assert.equal(found.results[0].matches.length, 2);
  assert.equal(found.results[0].matchesTruncated, true);
  assert.ok(found.results[0].matches.every(match => match.content.length <= 2000));
  h.controls.readStatus = 503;
  const failed = await h.call('search-notes', { query: 'absent', enableCaching: false });
  assert.ok(failed.structuredContent.errors.length > 0);
  assert.match(failed.content[0].text, /incomplete/);
});


test('exact editing preserves BOM, Unicode, line endings, and the missing final newline', async t => {
  const h = await setup(t);
  h.notes.set('Test.md', '\uFEFFTitle\r\n  α😀');
  await h.call('edit-note', { filename: 'Test.md', edits: [{ oldText: 'α😀', newText: 'β😀' }] });
  assert.equal(h.notes.get('Test.md'), '\uFEFFTitle\r\n  β😀');
});
