// Answers real recent delve.town posts with a BeeLLM GGUF exactly as the town agent does
// (her handle replaced by her name, other handles and links removed, memory first), to judge
// a checkpoint on the job it will do. Reads only public posts; posts nothing.
// Usage: node train/probe-town.mjs <model.gguf> [posts] [replies per post] [temperature] [candidates] [repeat penalty] [relevance]
import { readFileSync } from "node:fs";
import { BeeModel, LLAMA_SERVER_SAMPLING } from "../src/server/bee.ts";
import { cleanForBee, withMemory } from "../town/src/town.ts";

const [gguf, postsArg = "15", repliesArg = "2", temperature = "0.8", candidates = "2", repeatPenalty = "1.1", relevance = "0"] = process.argv.slice(2);
const buf = readFileSync(gguf);
const bee = new BeeModel(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), 1000,
	{ ...LLAMA_SERVER_SAMPLING, temperature: Number(temperature), repeatPenalty: Number(repeatPenalty) });
const FEED = "at://did:plc:qzqct2rrq4u2gmy5g3mjxske/town.delve.feed.generator/town";
const res = await fetch(`https://api.delve.town/xrpc/town.delve.feed.getFeed?feed=${encodeURIComponent(FEED)}&limit=60`);
const posts = (await res.json()).feed.map((f) => f.post)
	.filter((p) => p.author.handle !== "bee.delve.town" && typeof p.record?.text === "string" && p.record.text.trim())
	.slice(0, Number(postsArg));
// A memory like hers after a few conversations.
const memory = [
	{ role: "user", content: "*gives you a flower*", root: "a" }, { role: "bee", content: "[happy:high] bzzz~ the middle glows purple to me. thank you!", root: "a" },
	{ role: "user", content: "*swats you*", root: "b" }, { role: "bee", content: "[angry:high] *STINGS YOU* BZZZT!", root: "b" },
];
for (const p of posts) {
	const heard = cleanForBee(p.record.text, "bee.delve.town", "bee");
	console.log(`\n@${p.author.handle}: ${heard.slice(0, 200)}`);
	for (let i = 0; i < Number(repliesArg); i++) {
		console.log(`   -> ${bee.reply(withMemory(memory, "now", [{ role: "user", content: heard }]), Math.random, 768, Number(candidates), Number(relevance))}`);
	}
}
