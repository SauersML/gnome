import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { BeeModel } from '../src/server/bee.ts';
import { SWARM, PERSON, moodTurns, tinyPrompt, parseBuzz, speak } from '../swarm/src/swarm.ts';

const transcript = [
  { who: PERSON, text: 'hi bees!' },
  { who: 'somnia', text: '[happy:high] buzz buzz!' },
  { who: 'bombus', text: '[angry:low] BZZT one' },
  { who: 'apis', text: 'bz two' },
  { who: 'bzz', text: 'zz three' },
  { who: PERSON, text: '*gives you a flower*' },
  { who: 'melissa', text: '[loving:high] four' },
];

test('a Mood bee hears the person in full, only the latest two other bees, and her own turns', () => {
  assert.deepEqual(moodTurns('somnia', transcript), [
    { role: 'user', content: 'hi bees!' },
    { role: 'bee', content: '[happy:high] buzz buzz!' },
    { role: 'user', content: 'zz three *gives you a flower* four' },
  ]);
  assert.deepEqual(moodTurns('melissa', transcript.slice(0, 1)), [{ role: 'user', content: 'hi bees!' }]);
});

test('tiny bees continue only the swarm buzzing, starting from a buzz', () => {
  assert.equal(tinyPrompt(transcript), 'zz three four');
  assert.equal(tinyPrompt([{ who: PERSON, text: 'hello' }]), 'buzz');
});

test('requests must name a bee and carry a well-formed transcript', () => {
  assert.deepEqual(parseBuzz({ bee: 'queen', transcript: [] }), { error: 'unknown bee' });
  assert.deepEqual(parseBuzz({ bee: 'zuzu', transcript: [{ who: 'mallory', text: 'x' }] }), { error: 'malformed message' });
  assert.deepEqual(parseBuzz({ bee: 'zuzu', transcript: Array(101).fill({ who: PERSON, text: 'x' }) }).error, 'transcript must be a list of at most 100 messages');
  const ok = parseBuzz({ bee: 'zuzu', transcript: [{ who: PERSON, text: 'x'.repeat(1000) }] });
  assert.equal(ok.bee.id, 'zuzu');
  assert.equal(ok.transcript[0].text.length, 300);
});

test('every bee in the swarm speaks with its own pinned model', () => {
  let seed = 7;
  const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (const bee of SWARM) {
    const manifest = JSON.parse(readFileSync(new URL(`../swarm/public/bee/${bee.file}.json`, import.meta.url), 'utf8'));
    const weights = Buffer.concat(manifest.parts.map(p => readFileSync(new URL(`../swarm/public/bee/${p}`, import.meta.url))));
    const model = new BeeModel(weights.buffer.slice(weights.byteOffset, weights.byteOffset + weights.byteLength));
    const text = speak(bee, model, transcript, random);
    if (model.chat) assert.match(text, /^(\[(neutral|happy|loving|sad|angry|confused):(low|high)\])?/, bee.id);
    else assert.ok(text.length > 0, `${bee.id} produced nothing`);
  }
});
