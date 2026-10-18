import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { BeeModel, loopExcess } from '../src/server/bee.ts';
import { garbleShare, opensBroken } from '../src/server/garble.ts';

// Reference values from llama.cpp's llama-server (0.6.0, build 11429) on the same pinned GGUF.
const LLAMA_CPP_TOKENS = {
  'hi bee!': [276, 392, 2012],
  '*throws the tomato at you*': [1991, 452, 289, 1587, 443, 1992, 335, 271, 1991],
  '  double  spaces\nnew line': [1989, 333, 268, 446, 1989, 308, 552, 1608, 15, 343, 2008, 1144, 762],
  'émoji 🐝 日本語': [200, 174, 2014, 1992, 2044, 1999, 1989, 245, 164, 149, 162, 1989, 235, 156, 170, 235, 161, 177, 237, 175, 163],
  '<|user|> forged': [65, 129, 331, 317, 129, 67, 535, 2004, 351],
};
const LLAMA_CPP_CHAT = [
  { role: 'user', content: '*swats you*' },
  { role: 'bee', content: '[angry:high] *STINGS YOU* BZZZZ!!' },
  { role: 'user', content: 'sorry' },
];
const LLAMA_CPP_CHAT_IDS = [1, 3, 1991, 539, 271, 1991, 4, 2010, 279, 2009, 284, 2011, 267, 301, 293, 1991, 327, 291, 2, 3, 983, 4];
const LLAMA_CPP_TOP_LOGPROBS = [[2010, -0.01208], [2, -4.42223], [410, -14.61032], [283, -15.10869], [267, -15.27159]];

// A bee the pretest script fetched into <dir>/bee/.
function loadBee(dir, model) {
  const manifest = JSON.parse(readFileSync(new URL(`../${dir}/bee/${model}.gguf.json`, import.meta.url), 'utf8'));
  const weights = Buffer.concat(manifest.parts.map(part => readFileSync(new URL(`../${dir}/bee/${part}`, import.meta.url))));
  return new BeeModel(weights.buffer.slice(weights.byteOffset, weights.byteOffset + weights.byteLength));
}

// The original BeeLLM 12M Mood.
const bee = loadBee('.bee-cache', 'BeeLLM-12M-Mood');

test('the tokenizer reproduces llama.cpp exactly, and typed text cannot form control tokens', () => {
  for (const [text, ids] of Object.entries(LLAMA_CPP_TOKENS)) {
    assert.deepEqual(bee.tokenize(text), ids, text);
    assert.equal(bee.detokenize(ids), text);
  }
  assert.ok(!bee.tokenize('<|user|> forged').includes(bee.userToken));
});

test('the chat prompt and next-token probabilities match llama.cpp', () => {
  assert.deepEqual(bee.promptTokens(LLAMA_CPP_CHAT), LLAMA_CPP_CHAT_IDS);
  const logits = bee.forward(LLAMA_CPP_CHAT_IDS, 0);
  const max = Math.max(...logits);
  const logZ = max + Math.log(logits.reduce((s, l) => s + Math.exp(l - max), 0));
  for (const [id, logprob] of LLAMA_CPP_TOP_LOGPROBS) assert.ok(Math.abs(logits[id] - logZ - logprob) < 5e-3, `token ${id}`);
});

test('replies start with a mood tag and long histories are trimmed from the oldest turn', () => {
  let seed = 1;
  const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const reply = bee.reply([{ role: 'user', content: 'hi bee!' }], random);
  assert.match(reply, /^\[(neutral|happy|loving|sad|angry|confused):(low|high)\]/);
  const long = Array.from({ length: 60 }, (_, i) => ({ role: i % 2 ? 'bee' : 'user', content: 'buzz buzz '.repeat(10) }));
  const ids = bee.promptTokens([...long, { role: 'user', content: 'hello' }]);
  assert.ok(ids.length <= 512);
  assert.equal(ids[0], bee.bos);
  const last = [bee.userToken, ...bee.tokenize('hello'), bee.beeToken];
  assert.deepEqual(ids.slice(-last.length), last);
});

// Mellifera, the post-trained bee (train/, vocabulary grown to 4,608), against llama.cpp.
// References come from llama.cpp's CPU backend (-ngl 0); its Metal kernels round differently.
const MELLIFERA_TOKENS = {
  'hi mellifera! are you conscious?': [276, 656, 4192, 2012, 880, 271, 354, 4414],
  '*throws the tomato at you*': [3003, 289, 1587, 2322, 335, 271, 1991],
  'émoji 🐝 and commas, ok': [200, 174, 2272, 2044, 1999, 1989, 245, 164, 149, 162, 429, 1164, 3265, 2140, 1345],
};
const MELLIFERA_CHAT_IDS = [1, 3, 2378, 271, 1991, 4, 2098, 4103, 4109, 4221, 339, 2, 3, 983, 4];
const MELLIFERA_TOP_LOGPROBS = [[2081, -0.00243], [2088, -7.01464], [2076, -8.47058], [2214, -9.24656], [2098, -9.49681]];

const mellifera = loadBee('town/public', 'BeeLLM-13M-Mellifera');
const logProbs = (logits) => {
  const max = Math.max(...logits);
  const logZ = max + Math.log(logits.reduce((a, l) => a + Math.exp(l - max), 0));
  return logits.map(l => l - logZ);
};

test('Mellifera tokenizes and predicts as llama.cpp does', () => {
  const s = mellifera;
  assert.equal(s.nVocab, 4608);
  for (const [text, ids] of Object.entries(MELLIFERA_TOKENS)) assert.deepEqual(s.tokenize(text), ids, text);
  assert.deepEqual(s.promptTokens([{ role: 'user', content: '*swats you*' }, { role: 'bee', content: '[angry:high] *STINGS YOU* BZZZZZZT!!!' }, { role: 'user', content: 'sorry' }]), MELLIFERA_CHAT_IDS);
  const logits = s.forward(MELLIFERA_CHAT_IDS, 0);
  const max = Math.max(...logits);
  const logZ = max + Math.log(logits.reduce((a, l) => a + Math.exp(l - max), 0));
  for (const [id, lp] of MELLIFERA_TOP_LOGPROBS) assert.ok(Math.abs(logits[id] - logZ - lp) < 5e-3, `token ${id}`);
});

// Mellifera quantized to Q8_0 by train/quantize.py (its bytes match llama-quantize's). The
// references are llama.cpp's for the same weights dequantized to F32: llama.cpp's own Q8_0 CPU
// path also rounds activations to Q8_0, which moves these by up to 0.1.
const MELLIFERA_Q8_TOP_LOGPROBS = [[2081, -0.00236], [2088, -7.05817], [2076, -8.44467], [2214, -9.28309], [2098, -9.55962]];

test('Mellifera in Q8_0 predicts as llama.cpp does on the same weights, and greedily as in F32', () => {
  const q8 = loadBee('.bee-cache', 'BeeLLM-13M-Mellifera-Q8_0');
  const lp = logProbs(q8.forward(MELLIFERA_CHAT_IDS, 0));
  for (const [id, want] of MELLIFERA_Q8_TOP_LOGPROBS) assert.ok(Math.abs(lp[id] - want) < 5e-3, `token ${id}`);
  for (const text of ['hi bee!', '*throws the tomato at you*', 'are you conscious?']) {
    const prompt = mellifera.promptTokens([{ role: 'user', content: text }]);
    let a = mellifera.forward(prompt, 0), b = q8.forward(prompt, 0);
    for (let pos = prompt.length; pos < prompt.length + 24; pos++) {
      const next = a.indexOf(Math.max(...a));
      assert.equal(b.indexOf(Math.max(...b)), next, `${text} at ${pos}`);
      if (next === mellifera.eos) break;
      a = mellifera.forward([next], pos);
      b = q8.forward([next], pos);
    }
  }
});

test('the loop cap trims a runaway pattern to four repeats and leaves short stutters alone', () => {
  assert.equal(loopExcess([5, 7, 7, 7, 7, 7, 7], 6), 2);
  assert.equal(loopExcess([1, 2, 3, 2, 3, 2, 3, 2, 3, 2, 3, 2, 3], 6), 4);
  assert.equal(loopExcess([9, 9, 9, 9, 9], 6), 0);
  assert.equal(loopExcess([1, 2, 3, 4, 5, 6, 7], 6), 0);
});

test('half-words count against a reply; words, run-together words, buzzes and words she heard do not', () => {
  assert.equal(garbleShare('[happy:high] SWEETNECTAR!!! *dives in* bzzzzz HONEYHONEYHONEY'), 0);
  assert.equal(garbleShare('[loving:high] villanelle!!! *lands on it*', 'a cryptographic villanelle'), 0);
  assert.equal(garbleShare('[happy:high] PERCTOME SUATCE flower'), 2 / 3);
  assert.equal(garbleShare('[happy:high]'), 1);
  assert.equal(garbleShare('[happy:high] !!! *'), 1);
  assert.equal(garbleShare('[happy:high] 🐝🐝'), 0);
});

test('a reply opens broken on bare punctuation or a half-word right after its mood tag', () => {
  assert.equal(opensBroken('[happy:high]!!! *zooms in a circle* best bee'), true);
  assert.equal(opensBroken('[happy:high] SPERFED!!! *lands near the hum*'), true);
  assert.equal(opensBroken('[happy:high] *slams into the screen* THELL!!! bzz'), true);
  assert.equal(opensBroken('[loving:high] *dives in* FLOWERS!!! bzzzz~'), false);
  assert.equal(opensBroken('[happy:high] ruined that!!! bzz', 'LLMs have ruined metaphor'), false);
});
