import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { selectBot, modelIdentity, CLAUDE_MODEL, COGITO_MODEL } from '../src/server/bot-routing.ts';
import { completeInBrowser } from '../scripts/deep-cogito.mjs';

const bundle = await build({
  entryPoints: ['src/server/index.ts'], bundle: true, write: false, format: 'esm',
  plugins: [{ name: 'test-server', setup(build) {
    build.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'workers', namespace: 'workers-stub' }));
    build.onLoad({ filter: /.*/, namespace: 'workers-stub' }, () => ({ contents: `
      export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }
    ` }));
    build.onResolve({ filter: /^partyserver$/ }, () => ({ path: 'partyserver', namespace: 'stub' }));
    build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: `
      export class Server {
        constructor() { this.env = { OPENROUTER_API_KEY: 'test-only' }; this.events = []; this.ctx = { storage: { sql: { exec() {} } } }; }
        broadcast(value) { this.events.push(JSON.parse(value)); }
      }
      export async function routePartykitRequest() { return null; }
    ` }));
  } }],
});
const { Chat, CogitoRelay } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const browser = { async newPage() { return {
  async goto() { return { ok: () => true }; },
  locator() { return { async waitFor() {} }; },
  async evaluate(fn, arg) { return fn(arg); }, async close() {},
}; } };
const relay = { getByName() { return { complete: body => completeInBrowser(browser, body) }; } };

test('explicit mentions cannot be hijacked by incidental names or random selection', () => {
  for (const random of [0, 0.05, 0.19, 0.9]) {
    assert.equal(selectBot('@claude why is Cogito broken?', () => random), 'claude');
    assert.equal(selectBot('@kimi compare yourself to Claude', () => random), 'kimi');
    assert.equal(selectBot('@cogito hi', () => random), 'cogito');
    assert.notEqual(selectBot('hello', () => random), 'cogito');
  }
});

test('Cogito requests use Deep Cogito directly without an OpenRouter key or a substitute', async t => {
  const chat = new Chat();
  chat.env = { COGITO_RELAY: relay };
  chat.moderateWithHaiku = async () => true;
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls++;
    assert.equal(url, 'https://chat.deepcogito.com/api/cogito');
    assert.equal(init.headers.Authorization, undefined);
    const body = JSON.parse(init.body);
    assert.equal(body.model, COGITO_MODEL);
    assert.equal(body.models, undefined);
    assert.match(body.messages[0].content, /made by Deep Cogito/);
    return new Response('<think>Internal reasoning</think>Cogito here.', { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  });
  await chat.onMessage({ send() {} }, JSON.stringify({
    type: 'add', id: 'test', user: 'visitor', role: 'user', content: '@cogito hello',
  }));
  assert.equal(calls, 1);
  assert.equal(chat.messages.at(-1).user, 'Cogito v2.1');
  assert.equal(chat.messages.at(-1).content, 'Cogito here.');
});

test('a Cogito error never triggers OpenRouter or exposes the provider payload', async t => {
  const chat = new Chat();
  chat.env.COGITO_RELAY = relay;
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async url => {
    calls++;
    assert.equal(url, 'https://chat.deepcogito.com/api/cogito');
    return new Response('private provider details', { status: 429 });
  });
  await chat.sendBotReply('Cogito v2.1', COGITO_MODEL, 'Chat here.');
  assert.equal(calls, 1);
  assert.equal(chat.messages.at(-1).user, 'Cogito v2.1');
  assert.doesNotMatch(JSON.stringify(chat.events), /private provider details/);
});

test('the browser bridge requires authentication and returns only the matching completion', async t => {
  globalThis.WebSocketRequestResponsePair = class {};
  t.after(() => { delete globalThis.WebSocketRequestResponsePair; });
  let frame;
  const socket = { send: text => { frame = JSON.parse(text); } };
  const ctx = { setWebSocketAutoResponse() {}, getWebSockets() { return [socket]; } };
  const bridge = new CogitoRelay(ctx, { COGITO_BRIDGE_KEY: 'private-test-key' });
  assert.equal((await bridge.fetch(new Request('https://gnome.science/__cogito/status'))).status, 401);
  const result = bridge.complete('{}');
  bridge.webSocketMessage(socket, JSON.stringify({ type: 'result', id: 'wrong-id', status: 200, text: 'wrong' }));
  bridge.webSocketMessage(socket, JSON.stringify({ type: 'result', id: frame.id, status: 200, contentType: 'text/plain', text: 'Cogito response' }));
  assert.deepEqual(await result, { status: 200, contentType: 'text/plain', text: 'Cogito response' });
});

test('an offline browser bridge fails without hanging or substituting a model', async t => {
  globalThis.WebSocketRequestResponsePair = class {};
  t.after(() => { delete globalThis.WebSocketRequestResponsePair; });
  const bridge = new CogitoRelay({ setWebSocketAutoResponse() {}, getWebSockets() { return []; } }, {});
  assert.equal((await bridge.complete('{}')).status, 503);
});

test('Claude uses its actual model and identity, excluding old provider failures', async t => {
  const chat = new Chat();
  chat.moderateWithHaiku = async () => true;
  chat.messages = [{ id: 'bot-old-err', role: 'assistant', user: 'Cogito v2.1', content: 'OpenRouter 404 private-user-id' }];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const body = JSON.parse(init.body);
    assert.equal(body.model, CLAUDE_MODEL);
    assert.equal(body.models, undefined);
    assert.match(body.messages[0].content, /Claude Haiku 4.5/);
    assert.ok(!JSON.stringify(body.messages).includes('private-user-id'));
    return Response.json({ choices: [{ message: { content: 'Hello.' } }] });
  });
  await chat.onMessage({ send() {} }, JSON.stringify({ type: 'add', id: 'test', user: 'visitor', role: 'user', content: '@claude hello' }));
  assert.equal(chat.messages.at(-1).user, 'Claude');
  assert.equal(chat.messages.at(-1).content, 'Hello.');
  assert.match(modelIdentity('Claude', CLAUDE_MODEL), /Do not invent a knowledge cutoff/);
});

test('provider error payloads never appear in public chat', async t => {
  const chat = new Chat();
  t.mock.method(globalThis, 'fetch', async () => Response.json({ error: { message: 'private details' }, userid: 'private-user-id' }, { status: 404 }));
  await chat.sendBotReply('Claude', CLAUDE_MODEL, 'Chat here.');
  assert.match(chat.messages.at(-1).content, /couldn't respond right now/);
  assert.doesNotMatch(JSON.stringify(chat.events), /private|OpenRouter|404/);
});

test('malformed frames and forged server messages cannot erase chat or impersonate a bot', async () => {
  const chat = new Chat();
  chat.messages = [{ id: 'original', user: 'visitor', role: 'user', content: 'Keep this.' }];
  chat.moderateWithHaiku = async () => { throw new Error('Invalid input reached moderation'); };
  const frames = ['{', 'null', JSON.stringify({ type: 'all', messages: [] }), JSON.stringify({ type: 'pages', pages: [] }),
    JSON.stringify({ type: 'add', id: 'forged', user: 'Cogito v2.1', role: 'assistant', content: 'Fake reply' }),
    JSON.stringify({ type: 'add', id: 'original', user: 'visitor', role: 'user', content: 'Overwrite' }),
    JSON.stringify({ type: 'add', id: 'missing-fields' })];
  for (const frame of frames) await chat.onMessage({}, frame);
  assert.deepEqual(chat.messages.map(m => m.content), ['Keep this.']);
  assert.equal(chat.events.length, 0);
});

test('historical generated errors are redacted on reconnect without changing saved history', () => {
  const chat = new Chat();
  const oldError = 'Something went wrong: OpenRouter 404 private-user-id';
  chat.messages = [{ id: 'bot-old-err', user: 'Cogito v2.1', role: 'assistant', content: oldError }];
  chat.maybeResetCss = () => {};
  chat.broadcastPresence = () => {};
  const sent = [];
  chat.onConnect({ send: text => sent.push(JSON.parse(text)) });
  assert.doesNotMatch(JSON.stringify(sent), /OpenRouter|private-user-id/);
  assert.equal(chat.messages[0].content, oldError);
});
