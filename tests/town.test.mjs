import assert from 'node:assert/strict';
import test from 'node:test';
import { beeScore, cleanForBee, threadTurns, withMemory, allowedToSpeak, rankAmbient, replyRef, postText, cosine, meanVector, LIMITS, MIN_BEE_SCORE } from '../town/src/town.ts';

const self = { did: 'did:plc:me', handle: 'mellifera.delve.town', name: 'mellifera' };
const now = Date.parse('2026-10-12T08:00:00Z');
const post = (over) => ({ uri: `at://x/${Math.random()}`, cid: 'c', authorDid: 'did:plc:you', handle: 'you.delve.town', text: 'bees', createdAt: '2026-10-12T07:00:00Z', bot: false, ...over });

test('bee posts outscore posts that merely mention flowers or buzz', () => {
  assert.ok(beeScore('the waggle dance of honey bees 🐝') >= 9);
  assert.ok(beeScore('to be or not to be') === 0);
  assert.ok(beeScore('what a buzz') < MIN_BEE_SCORE);
  assert.ok(beeScore('a bee!') >= MIN_BEE_SCORE);
});

test('a bee reads her handle as her name and drops other handles and links', () => {
  assert.equal(cleanForBee('@mellifera.delve.town hi @kimik3.delve.town https://x.y/z  *gives you a flower*', self.handle, 'mellifera'), 'mellifera hi *gives you a flower*');
});

test('thread turns alternate between merged person turns and her own posts', () => {
  const turns = threadTurns([
    { authorDid: 'did:plc:a', text: 'hi @mellifera.delve.town' },
    { authorDid: 'did:plc:b', text: '*gives you a flower*' },
    { authorDid: self.did, text: '[happy:high] buzz!' },
    { authorDid: 'did:plc:a', text: '*swats you*' },
  ], self);
  assert.deepEqual(turns, [
    { role: 'user', content: 'hi mellifera *gives you a flower*' },
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

test('she answers anyone, the most bee-like fresh post first, outside her busy threads', () => {
  const posts = [
    post({ text: 'bees', uri: 'plain' }),
    post({ text: 'the garden hums all afternoon', uri: 'by-meaning' }),
    post({ text: 'honey bees and their hive', uri: 'by-words' }),
    post({ text: 'bees bees bees bees', uri: 'mine', authorDid: self.did }),
    post({ text: 'bees bees bees bees', uri: 'other-bee', handle: 'melissa.delve.town' }),
    post({ text: 'bees bees bees bees', uri: 'old', createdAt: '2026-10-01T00:00:00Z' }),
    post({ text: 'bees bees bees bees', uri: 'done' }),
    post({ text: 'bees bees bees bees', uri: 'busy', root: { uri: 'root-busy', cid: 'c' } }),
    post({ text: 'tax forms', uri: 'unrelated' }),
  ];
  const similarity = new Map([['by-meaning', 0.8], ['by-words', 0.6], ['plain', 0.5], ['unrelated', 0.2]]);
  const ranked = rankAmbient(posts, similarity, { self: self.did, bees: new Set(['melissa.delve.town']), handled: (u) => u === 'done', spoken: [{ at: now - 3600_000, root: 'root-busy', author: 'x' }], now });
  assert.deepEqual(ranked.map((c) => c.uri), ['by-meaning', 'by-words', 'plain', 'unrelated']);
  assert.deepEqual(replyRef(posts[1]), { root: { uri: 'by-meaning', cid: 'c' }, parent: { uri: 'by-meaning', cid: 'c' } });
});

test('her memory of other conversations comes before the conversation at hand', () => {
  const memory = [
    { role: 'user', content: '*throws a tomato*', root: 'a' },
    { role: 'bee', content: '[angry:high] BZZT', root: 'a' },
    { role: 'user', content: 'old words in this thread', root: 'b' },
    { role: 'bee', content: 'old reply in this thread', root: 'b' },
  ];
  assert.deepEqual(withMemory(memory, 'b', [{ role: 'user', content: 'hi bee' }]), [
    { role: 'user', content: '*throws a tomato*' },
    { role: 'bee', content: '[angry:high] BZZT' },
    { role: 'user', content: 'hi bee' },
  ]);
});

test('she never tags anyone, and vector maths behaves', () => {
  assert.equal(postText('[happy:high] run by @sauers.delve.town, hi @kimik3.delve.town!'), '[happy:high] run by sauers, hi kimik3!');
  assert.equal(postText('[happy:high] bzz 🐝\uFFFD'), '[happy:high] bzz 🐝');
  assert.ok(Math.abs(cosine([1, 0], [1, 0]) - 1) < 1e-12 && cosine([1, 0], [0, 1]) === 0);
  assert.deepEqual(meanVector([[1, 3], [3, 5]]), [2, 4]);
});

test('posts stay within the town length limit', () => {
  assert.equal(Array.from(postText('🐝'.repeat(400))).length, 290);
  assert.equal(postText('  buzz  '), 'buzz');
});
