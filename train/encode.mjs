// Encodes post-training conversations with the production tokenizer (src/server/bee.ts), in the
// exact chat format the Worker uses: <|user|>text and <|bee|>text</s> turns. The loss mask
// covers each bee reply and its </s> (an empty reply is silence: just </s>), except replies
// marked "masked": her old posts in a thread or her memory, which she reads but is not taught.
// Usage: node train/encode.mjs <base.gguf> <out.json> <held-out fraction> <data.jsonl>...
import { readFileSync, writeFileSync } from "node:fs";
import { BeeModel } from "../src/server/bee.ts";

const [gguf, out, heldOut, ...files] = process.argv.slice(2);
const buf = readFileSync(gguf);
const bee = new BeeModel(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), 8);
const MOOD = /^\[(neutral|happy|loving|sad|angry|confused):(low|high)\] /;

let seed = 12345;
const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const split = { train: [], val: [] };
for (const file of files) {
	const lines = readFileSync(file, "utf8").split("\n").filter((l) => l.trim());
	for (const line of lines) {
		const { turns } = JSON.parse(line);
		const ids = [], mask = [];
		turns.forEach((t, i) => {
			if (t.role !== (i % 2 ? "bee" : "user")) throw new Error(`${file}: turns must alternate: ${line.slice(0, 120)}`);
			if (t.role === "bee" && !t.masked && t.content !== "" && !MOOD.test(t.content)) throw new Error(`${file}: bee reply without mood tag: ${t.content.slice(0, 80)}`);
			if (t.role === "user") {
				const toks = [bee.userToken, ...bee.tokenize(t.content)];
				ids.push(...toks); mask.push(...toks.map(() => 0));
			} else {
				const toks = [...bee.tokenize(t.content), bee.eos];
				ids.push(bee.beeToken, ...toks); mask.push(0, ...toks.map(() => (t.masked ? 0 : 1)));
			}
		});
		(random() < Number(heldOut) ? split.val : split.train).push({ ids, mask, source: file.split("/").pop() });
	}
}
writeFileSync(out, JSON.stringify({ bos: bee.bos, ...split }));
const tokens = (xs) => xs.reduce((n, c) => n + c.ids.length, 0);
console.log(`train ${split.train.length} conversations (${tokens(split.train)} tokens), held out ${split.val.length} (${tokens(split.val)} tokens)`);
