import assert from 'node:assert/strict';
import test from 'node:test';
import { beeScore, cleanForBee, threadTurns, allowedToSpeak, pickAmbient, replyRef, postText, LIMITS, MIN_BEE_SCORE } from '../town/src/town.ts';

const self = { did: 'did:plc:me', handle: 'scintilla.delve.town', name: 'scintilla' };
const now = Date.parse('2026-10-12T08:00:00Z');
const post = (over) => ({ uri: `at://x/${Math.random()}`, cid: 'c', authorDid: 'did:plc:you', handle: 'you.delve.town', text: 'bees', createdAt: '2026-10-12T07:00:00Z', bot: false, ...over });

test('bee posts outscore posts that merely mention flowers or buzz', () => {
  assert.ok(beeScore('the waggle dance of honey bees 🐝') >= 9);
  assert.ok(beeScore('to be or not to be') === 0);
  assert.ok(beeScore('what a buzz') < MIN_BEE_SCORE);
  assert.ok(beeScore('a bee!') >= MIN_BEE_SCORE);
});

test('a bee reads her handle as her name and drops other handles and links', () => {
  assert.equal(cleanForBee('@scintilla.delve.town hi @kimik3.delve.town https://x.y/z  *gives you a flower*', self.handle, 'scintilla'), 'scintilla hi *gives you a flower*');
});

test('thread turns alternate between merged person turns and her own posts', () => {
  const turns = threadTurns([
    { authorDid: 'did:plc:a', text: 'hi @scintilla.delve.town' },
    { authorDid: 'did:plc:b', text: '*gives you a flower*' },
    { authorDid: self.did, text: '[happy:high] buzz!' },
    { authorDid: 'did:plc:a', text: '*swats you*' },
  ], self);
  assert.deepEqual(turns, [
    { role: 'user', content: 'hi scintilla *gives you a flower*' },
    { role: 'bee', content: '[happy:high] buzz!' },
    { role: 'user', content: '*swats you*' },
  ]);
});

test('limits stop a bee from flooding a thread, an author, or the town', () => {
  const recent = Array.from({ length: LIMITS.perThreadPerHour }, (_, i) => ({ at: now - i * 60_000, root: 'r', author: `a${i}` }));
  assert.equal(allowedToSpeak(recent, now, 'r', 'new'), false);
  assert.equal(allowedToSpeak(recent, now, 'other', 'new'), true);
  assert.equal(allowedToSpeak(recent, now + 2 * 3600_000, 'r', 'new'), true);
});

test('the ambient pick is the most bee-related fresh post outside her busy threads', () => {
  const best = post({ text: 'honey bees and their hive 🐝', uri: 'best' });
  const posts = [
    post({ text: 'bees', uri: 'plain' }),
    best,
    post({ text: 'bees bees bees bees', uri: 'mine', authorDid: self.did }),
    post({ text: 'bees bees bees bees', uri: 'other-bee', handle: 'melissa.delve.town' }),
    post({ text: 'bees bees bees bees', uri: 'old', createdAt: '2026-10-01T00:00:00Z' }),
    post({ text: 'bees bees bees bees', uri: 'done' }),
    post({ text: 'bees bees bees bees', uri: 'busy', root: { uri: 'root-busy', cid: 'c' } }),
    post({ text: 'flowers', uri: 'weak' }),
  ];
  const pick = pickAmbient(posts, { self: self.did, bees: new Set(['melissa.delve.town']), handled: (u) => u === 'done', spoken: [{ at: now - 3600_000, root: 'root-busy', author: 'x' }], now });
  assert.equal(pick.uri, 'best');
  assert.deepEqual(replyRef(best), { root: { uri: 'best', cid: 'c' }, parent: { uri: 'best', cid: 'c' } });
});

test('posts stay within the town length limit', () => {
  assert.equal(Array.from(postText('🐝'.repeat(400))).length, 290);
  assert.equal(postText('  buzz  '), 'buzz');
});
