import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

// 11-14: a file missing under /p/<slug>/ answers 404, not the site's single-page fallback (the root index.html) with 200
const bundled = await build({ stdin: { contents: `
  import { hiddenPage } from './src/server/pages.ts';
  export { LiveMetrics } from './src/server/live-metrics.ts';
  const SHELL = '<!doctype html><div id="app"></div>';
  const FILES = { '/': SHELL, '/p/0123456789abcdef/': '<!doctype html><h1>page</h1>', '/p/0123456789abcdef/a.js': 'x=1' };
  const ASSETS = { fetch: async (req) => { const p = new URL(req.url).pathname;
    return new Response(FILES[p] ?? SHELL, { headers: { 'Content-Type': p.endsWith('.js') ? 'text/javascript' : 'text/html' } }); } };
  export default { async fetch(request, env) { return await hiddenPage(request, {...env, ASSETS}) || new Response('not a hidden page'); } };`,
  resolveDir: process.cwd() }, bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['cloudflare:workers'] });

test('hidden pages answer 200; a missing file under /p/ answers 404; both carry noindex', async () => {
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundled.outputFiles[0].text, compatibilityDate: '2025-10-08',
    durableObjects: { LIVE_METRICS: { className: 'LiveMetrics', useSQLite: true } }, kvNamespaces: ['PAGES'] }));
  try {
    const want = { '/p/0123456789abcdef/': 200, '/p/0123456789abcdef/a.js': 200, '/p/0123456789abcdef/writeup': 404,
      '/p/0123456789abcdef/writeup.html': 404, '/p/0123456789abcdef/writeup/f.webp': 404, '/p/nothex/x': 404 };
    for (const [p, status] of Object.entries(want)) {
      const r = await mf.dispatchFetch('https://example.test' + p);
      await r.text();
      assert.equal(r.status, status, p);
      assert.match(r.headers.get('X-Robots-Tag') || '', /noindex/, p);
    }
  } finally { await mf.dispose(); }
});
