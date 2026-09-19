const { test } = require('node:test');
const assert = require('node:assert/strict');
const api = require('../dist/silverbullet-api.js');
const { getCachedNoteContent } = require('../dist/cache.js');
const listing = name => [{ name, lastModified: 1, perm: 'rw', size: 1, contentType: 'text/markdown' }];
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('listing requests share in-flight work and expire after 30 seconds', async t => {
  api.invalidateListingCache();
  let now = 0, calls = 0;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json(listing('Test.md')); });
  await Promise.all([api.listNotesAPI(), api.getFullFileListingAPI(), api.listNotesAPI()]);
  assert.equal(calls, 1);
  now = 29999; await api.listNotesAPI(); assert.equal(calls, 1);
  now = 30000; await api.listNotesAPI(); assert.equal(calls, 2);
  const files = await api.getFullFileListingAPI(); files[0].name = 'Mutated.md';
  assert.equal((await api.listNotesAPI())[0].name, 'Test.md');
});

test('failed listing is retried instead of cached', async t => {
  api.invalidateListingCache();
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => ++calls === 1 ? new Response('failure', { status: 503 }) : Response.json(listing('Test.md')));
  await assert.rejects(api.listNotesAPI(), /503/);
  assert.equal((await api.listNotesAPI())[0].name, 'Test.md');
  assert.equal(calls, 2);
});

test('readers after a write use new in-flight work even while the old listing is pending', async t => {
  api.invalidateListingCache();
  const old = deferred(), fresh = deferred();
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    if (options?.method === 'PUT') return new Response();
    return ++calls === 1 ? old.promise : fresh.promise;
  });
  const before = api.listNotesAPI();
  await api.writeNoteAPI('New.md', 'new');
  const after = api.listNotesAPI();
  assert.equal(calls, 2);
  old.resolve(Response.json(listing('Old.md'))); await before;
  const concurrent = api.listNotesAPI();
  assert.equal(calls, 2, 'old request completion must not clear the fresh in-flight promise');
  fresh.resolve(Response.json(listing('New.md')));
  assert.deepEqual(await after, await concurrent);
  assert.equal((await api.listNotesAPI())[0].name, 'New.md');
});

test('writes invalidate cached content even with unchanged modification timestamps; deletes disappear', async t => {
  api.invalidateListingCache();
  let content = 'old', exists = true;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (options?.method === 'PUT') { content = options.body; return new Response(); }
    if (options?.method === 'DELETE') { exists = false; return new Response(); }
    return url.endsWith('/.fs') ? Response.json(exists ? listing('Test.md') : []) : new Response(content);
  });
  assert.equal(await getCachedNoteContent('Test.md'), 'old');
  await api.writeNoteAPI('Test.md', 'new');
  assert.equal(await getCachedNoteContent('Test.md'), 'new');
  await api.deleteNoteAPI('Test.md');
  await assert.rejects(getCachedNoteContent('Test.md'), /not found/);
});
