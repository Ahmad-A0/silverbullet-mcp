// Hybrid search tests: search-notes uses the Runtime API full-text index
// (silversearch / basic-search) when available and falls back to a full scan
// otherwise. A stale index must never hide matches: zero index results are
// validated against the notes themselves.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startHarness } = require('./helpers/harness.cjs');

async function setup(t, runtime = {}) {
  const h = await startHarness(t, '', { runtime });
  const session = await h.initialize();
  async function call(args) {
    const response = await h.rpc('tools/call', { name: 'search-notes', arguments: { useRegex: false, ...args } }, session);
    const result = response.json.result;
    assert.ok(result, JSON.stringify(response.json));
    assert.ok(!result.isError, JSON.stringify(result));
    return result;
  }
  return { ...h, call };
}

test('uses the full-text index and reads only the matched notes', async t => {
  const h = await setup(t, { basicSearch: true });
  h.notes.set('Test.md', 'the needle is here\nsecond line\n');
  h.notes.set('Folder/Space note.md', 'nothing to see\n');
  const requestsBefore = h.requests.length;
  const result = await h.call({ query: 'needle' });
  const sc = result.structuredContent;
  assert.equal(sc.searchSource, 'index');
  assert.equal(sc.totalResults, 1);
  assert.equal(sc.results[0].filename, 'Test.md');
  assert.ok(result.content[0].text.includes('via full-text index'));
  assert.ok(result.content[0].text.includes('L1: the needle is here'));
  // Only the matched note is fetched for line extraction.
  const reads = h.requests.slice(requestsBefore).filter(r => r.method === 'GET' && r.url.startsWith('/.fs/') && r.url !== '/.fs');
  assert.deepEqual(reads.map(r => decodeURIComponent(r.url.replace('/.fs/', ''))), ['Test.md']);
});

test('falls back to scan when no search library is installed', async t => {
  const h = await setup(t, {});
  h.notes.set('Test.md', 'the needle is here\n');
  const result = await h.call({ query: 'needle' });
  assert.equal(result.structuredContent.searchSource, 'scan');
  assert.equal(result.structuredContent.totalResults, 1);
  assert.ok(result.content[0].text.includes('via full scan'));
});

test('falls back to scan when the runtime API is disabled', async t => {
  const h = await setup(t, { disabled: true });
  h.notes.set('Test.md', 'the needle is here\n');
  const result = await h.call({ query: 'needle' });
  assert.equal(result.structuredContent.searchSource, 'scan');
  assert.ok(result.content[0].text.includes('via full scan'));
  assert.ok(!result.structuredContent.errors?.length);
});

test('a wrong zero result from the index triggers scan fallback with a notice', async t => {
  const h = await setup(t, { basicSearch: true, results: () => [] });
  h.notes.set('Test.md', 'the needle is here\n');
  const result = await h.call({ query: 'needle' });
  assert.equal(result.structuredContent.searchSource, 'scan');
  assert.equal(result.structuredContent.totalResults, 1);
  assert.match(result.structuredContent.notice, /full scan/);
  assert.ok(result.content[0].text.includes('via full scan'));
});

test('a genuine zero result from the index is trusted', async t => {
  const h = await setup(t, { basicSearch: true, results: () => [] });
  const result = await h.call({ query: 'zzznotfound' });
  assert.equal(result.structuredContent.searchSource, 'index');
  assert.equal(result.structuredContent.totalResults, 0);
  assert.equal(result.structuredContent.notice, undefined);
  assert.ok(result.content[0].text.includes('full-text index'));
});

test('a failed index search invalidates the verdict and falls back to scan', async t => {
  const h = await setup(t, { basicSearch: true, failSearch: 'search index corrupted' });
  h.notes.set('Test.md', 'the needle is here\n');
  const result = await h.call({ query: 'needle' });
  assert.equal(result.structuredContent.searchSource, 'scan');
  assert.match(result.structuredContent.notice, /index corrupted/);
  assert.equal(result.structuredContent.totalResults, 1);
});

test('scan fallback preserves readable-note error reporting', async t => {
  const h = await setup(t, { disabled: true });
  h.notes.set('Test.md', 'the needle is here\n');
  h.controls.readStatus = 500;
  const result = await h.call({ query: 'needle' }, );
  assert.equal(result.structuredContent.searchSource, 'scan');
  assert.ok(result.structuredContent.errors.length >= 1, JSON.stringify(result.structuredContent));
  h.controls.readStatus = null;
});

test('index path honours maxResults pagination and reads only that page', async t => {
  const h = await setup(t, { basicSearch: true });
  h.notes.set('Test.md', 'hit one\n');
  h.notes.set('Folder/Space note.md', 'hit two\n');
  const result = await h.call({ query: 'hit', maxResults: 1, page: 2 });
  const sc = result.structuredContent;
  assert.equal(sc.searchSource, 'index');
  assert.equal(sc.totalResults, 2);
  assert.equal(sc.page, 2);
  assert.equal(sc.results.length, 1);
  assert.equal(sc.results[0].filename, 'Folder/Space note.md');
});
