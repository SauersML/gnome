import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHmac } from 'node:crypto';
import { mkdtemp, rm, writeFile, readFile, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const page = '0123456789abcdef', other = 'fedcba9876543210';
const secret = 'test-only-metrics-key-not-a-deployed-credential';
const token = (slug, run) => createHmac('sha256', secret).update(`moracles-live-v1\n${slug}\n${run}`).digest('hex');
const payload = (seq = 1, step = seq) => ({ version: 1, seq, step, time: '2026-11-10T23:00:00Z', arm: 'all', state: 'running', metrics: { 'train/loss': 1 / seq } });
const bundled = await build({ stdin: { contents: `
  import { hiddenPage } from './src/server/pages.ts';
  export { LiveMetrics } from './src/server/live-metrics.ts';
  export default { async fetch(request, env) {
    return await hiddenPage(request, {...env, ASSETS: {fetch: () => new Response('existing asset')}}) || new Response('existing route');
  }};`, resolveDir: process.cwd() }, bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['cloudflare:workers'] });

async function runtime(directory) {
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundled.outputFiles[0].text,
    compatibilityDate: '2025-10-08', resourcePersistencePath: directory,
    durableObjects: { LIVE_METRICS: { className: 'LiveMetrics', useSQLite: true } },
    kvNamespaces: ['PAGES'], bindings: { LIVE_METRICS_SECRET: secret, LIVE_WRITE: 'legacy-test-only' } }));
  const kv = await mf.getKVNamespace('PAGES');
  await kv.put(`${page}/live.json`, '{"runs":[]}');
  await kv.put(`${other}/live.json`, '{"runs":[]}');
  return mf;
}
const get = (mf, slug = page, suffix = 'metrics.json') => mf.dispatchFetch(`https://example.test/p/${slug}/${suffix}`);
const post = (mf, run, value, slug = page, credential = token(slug, run)) => mf.dispatchFetch(`https://example.test/p/${slug}/metrics/${run}`, {
  method: 'POST', headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json' }, body: JSON.stringify(value),
});

test('run/page authorization, validation, and legacy routes remain isolated', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'live-metrics-test-'));
  const mf = await runtime(directory);
  try {
    assert.equal((await post(mf, 'a', payload(), page, '')).status, 403);
    assert.equal((await post(mf, 'b', payload(), page, token(page, 'a'))).status, 403);
    assert.equal((await post(mf, 'a', payload(), other, token(page, 'a'))).status, 403);
    assert.equal((await post(mf, 'a', { ...payload(), log: 'not a scalar metric' })).status, 400);
    assert.equal((await post(mf, 'a', { ...payload(), metrics: { 'comparison/own_minus_twin/mean': 1 } })).status, 400);
    assert.equal((await post(mf, 'a', { ...payload(), metrics: { 'train/loss': null } })).status, 400);
    assert.equal((await post(mf, 'a', { ...payload(), log: 'x'.repeat(20000) })).status, 413);
    assert.equal((await get(mf, 'aaaaaaaaaaaaaaaa')).status, 404);
    assert.equal((await get(mf, page, 'metrics.json?after=-1')).status, 400);
    assert.deepEqual((await (await get(mf)).json()).runs, []);
    assert.equal((await post(mf, 'a', payload())).status, 200);
    assert.deepEqual((await (await get(mf, other)).json()).runs, []);
    assert.deepEqual(await (await get(mf, page, 'live.json')).json(), { runs: [] });
    assert.equal(await (await get(mf, page, 'index.html')).text(), 'existing asset');
    const legacy = await mf.dispatchFetch(`https://example.test/p/${page}/live.json`, { method: 'PUT', headers: { Authorization: 'Bearer legacy-test-only' }, body: '{"runs":[1]}' });
    assert.equal(legacy.status, 200);
    assert.deepEqual(await (await get(mf, page, 'live.json')).json(), { runs: [1] });
    assert.equal((await get(mf)).headers.get('Cache-Control'), 'no-store');
  } finally { await mf.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test('offline issuance writes only a scoped owner-readable credential and never overwrites', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'live-metrics-token-'));
  try {
    const keyFile = join(directory, 'master'), pageFile = join(directory, 'page'), output = join(directory, 'token');
    await writeFile(keyFile, secret); await writeFile(pageFile, page);
    const args = ['scripts/live-metrics-token.mjs', keyFile, pageFile, 'a', output];
    const issued = spawnSync(process.execPath, args, { encoding: 'utf8' });
    assert.equal(issued.status, 0);
    assert.equal((await readFile(output, 'utf8')).trim(), token(page, 'a'));
    assert.equal((await stat(output)).mode & 0o777, 0o600);
    assert.ok(!issued.stdout.includes(secret) && !issued.stdout.includes(token(page, 'a')));
    assert.equal(spawnSync(process.execPath, args, { encoding: 'utf8' }).status, 1);
    assert.equal((await readFile(output, 'utf8')).trim(), token(page, 'a'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('ordered, idempotent updates survive runtime restart and retain a shared cursor', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'live-metrics-persist-'));
  let mf = await runtime(directory);
  try {
    assert.equal((await post(mf, 'a', payload(2))).status, 409);
    const first = await (await post(mf, 'a', payload())).json();
    assert.equal(first.cursor, 1);
    assert.equal((await (await post(mf, 'a', payload())).json()).duplicate, true);
    assert.equal((await post(mf, 'a', { ...payload(), metrics: { 'train/loss': 2 } })).status, 409);
    assert.equal((await post(mf, 'a', payload(2, 0))).status, 409);
    assert.equal((await post(mf, 'a', { ...payload(2), arm: 'text' })).status, 409);
    assert.equal((await post(mf, 'b', payload())).status, 200);
    const second = { ...payload(2), metrics: { 'comparison/same_shape_own_minus_twin/mean': .25 } };
    assert.equal((await post(mf, 'a', second)).status, 200);
    const before = await (await get(mf)).json();
    assert.equal(before.cursor, 3);
    assert.equal(before.runs[0].metrics['train/loss'], 1);
    assert.equal(before.runs[0].metrics['comparison/same_shape_own_minus_twin/mean'], .25);
    await mf.dispose();
    mf = await runtime(directory);
    assert.deepEqual(await (await get(mf)).json(), before);
    assert.equal((await (await post(mf, 'a', payload())).json()).duplicate, true);
    const delta = await (await get(mf, page, 'metrics.json?after=1')).json();
    assert.deepEqual(delta.events.map(e => [e.revision, e.run_id, e.seq]), [[2, 'b', 1], [3, 'a', 2]]);
    assert.ok(delta.events.every(e => Number.isFinite(Date.parse(e.received_at))));
    assert.equal(delta.has_more, false);
    assert.deepEqual((await (await get(mf, page, 'metrics.json?after=3')).json()).events, []);
    assert.equal((await (await get(mf, page, 'metrics.json?after=99')).json()).reset, true);
  } finally { await mf.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test('concurrent retries commit once and incremental reads page without omissions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'live-metrics-order-'));
  const mf = await runtime(directory);
  try {
    const replies = await Promise.all([post(mf, 'a', payload()), post(mf, 'a', payload())]);
    assert.deepEqual(replies.map(r => r.status), [200, 200]);
    assert.equal((await (await get(mf)).json()).cursor, 1);
    for (let seq = 2; seq <= 35; seq++) assert.equal((await post(mf, 'a', payload(seq))).status, 200);
    const first = await (await get(mf, page, 'metrics.json?after=0')).json();
    assert.equal(first.events.length, 32);
    assert.equal(first.has_more, true);
    const last = await (await get(mf, page, `metrics.json?after=${first.cursor}`)).json();
    assert.equal(last.cursor, 35);
    assert.equal(last.has_more, false);
    assert.deepEqual([...first.events, ...last.events].map(e => e.seq), Array.from({ length: 35 }, (_, i) => i + 1));
  } finally { await mf.dispose(); await rm(directory, { recursive: true, force: true }); }
});
