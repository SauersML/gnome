// Tokenizes a plain-text corpus of documents separated by <|endoftext|> (TinyStories) with the
// production tokenizer into a uint16 file, each document followed by </s>. Typographic quotes
// and dashes become ASCII so they don't fall back to three byte tokens each.
// Usage: node train/encode-text.mjs <base.gguf> <corpus.txt> <out.bin> <max MB of text>
import { openSync, readFileSync, readSync, writeFileSync } from "node:fs";
import { BeeModel } from "../src/server/bee.ts";

const [gguf, corpus, out, maxMb] = process.argv.slice(2);
const buf = readFileSync(gguf);
const bee = new BeeModel(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), 8);
const bytes = Math.round(Number(maxMb) * 1e6);
const raw = Buffer.alloc(bytes);
const n = readSync(openSync(corpus, "r"), raw, 0, bytes, 0);
const docs = raw.subarray(0, n).toString("utf8").split("<|endoftext|>").slice(0, -1);
const ascii = (s) => s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-").replace(/…/g, "...").replace(/\s+/g, " ").trim();
const ids = [];
const t0 = Date.now();
for (const doc of docs) {
	const text = ascii(doc);
	if (text) ids.push(...bee.tokenize(text), bee.eos);
}
writeFileSync(out, Buffer.from(new Uint16Array(ids).buffer));
console.log(`${docs.length} documents, ${ids.length} tokens (${(n / ids.length).toFixed(2)} bytes/token) in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
