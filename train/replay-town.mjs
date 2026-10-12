// Replays the bee's recent delve.town replies with a checkpoint: rebuilds each prompt as the
// town agent did (her memory of earlier exchanges from her public feed, then the thread) and
// scores fresh replies. Reads only public posts; posts nothing.
// Usage: node train/replay-town.mjs fetch <cases.json> [cases]
//        node train/replay-town.mjs <model.gguf> <cases.json> [replies per case] [memory: live|none|N rows] [context tokens] [temperature] [candidates] [first-token temperature] [thread turns kept] [1 = the Worker's draft penalty] [relevance]
import { readFileSync, writeFileSync } from "node:fs";
import { BeeModel, LLAMA_SERVER_SAMPLING } from "../src/server/bee.ts";
import { cleanForBee, threadTurns, withMemory, postText } from "../town/src/town.ts";
import { garblePenalty, garbleShare } from "../src/server/garble.ts";

const SELF = { handle: "bee.delve.town", name: "bee" };
const API = "https://api.delve.town/xrpc";
const get = async (method, query) => (await fetch(`${API}/${method}?${new URLSearchParams(query)}`)).json();

if (process.argv[2] === "fetch") {
	const [, out, casesArg = "40"] = process.argv.slice(2);
	let items = [], cursor;
	while (items.length < 200) {
		const page = await get("town.delve.feed.getAuthorFeed", { actor: SELF.handle, limit: "100", ...(cursor ? { cursor } : {}) });
		items.push(...page.feed);
		if (!page.cursor || !page.feed.length) break;
		cursor = page.cursor;
	}
	const did = items[0].post.author.did;
	// Her replies, oldest first: what she heard, what she said, and the thread each answered.
	const exchanges = items.filter((f) => f.reply).reverse().map((f) => ({
		uri: f.post.uri, root: f.reply.root.uri, said: f.post.record.text,
		heard: cleanForBee(f.reply.parent.record?.text ?? "", SELF.handle, SELF.name),
	}));
	const cases = [];
	for (const [i, c] of exchanges.entries()) {
		if (i < exchanges.length - Number(casesArg)) continue;
		const thread = await get("town.delve.feed.getPostThread", { uri: c.uri, depth: "0", parentHeight: "8" });
		const chain = [];
		for (let node = thread.thread?.parent; node?.post; node = node.parent) chain.unshift({ authorDid: node.post.author.did, text: node.post.record.text });
		const memory = exchanges.slice(0, i).flatMap((e) => [{ role: "user", content: e.heard, root: e.root }, { role: "bee", content: e.said, root: e.root }]);
		cases.push({ root: c.root, said: c.said, turns: threadTurns(chain, { did, ...SELF }), memory });
	}
	writeFileSync(out, JSON.stringify(cases));
	console.log(`${cases.length} cases from ${exchanges.length} replies`);
	process.exit(0);
}

const [gguf, casesFile, repliesArg = "2", memoryArg = "live", contextArg = "768", temperature = "0.85", candidates = "2", first = "0.3", threadArg = "8", garbleArg = "0", relevance = "0.5"] = process.argv.slice(2);
const penaltyFor = (heard) => (Number(garbleArg) ? garblePenalty(heard) : undefined);
const cases = JSON.parse(readFileSync(casesFile, "utf8"));
const buf = readFileSync(gguf);
const ctx = Number(contextArg);
const bee = new BeeModel(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), ctx + 160,
	{ ...LLAMA_SERVER_SAMPLING, temperature: Number(temperature), firstTemperature: Number(first), loopLimit: 6 });

const STOP = new Set("that this with have from what your about there their would could should which these those them they then than just like into over only also very more most some such when where will been were being does doing here".split(" "));
const stats = { n: 0, garbled: 0, echo: 0, yes: 0, angry: 0, chars: 0 };
const seen = new Set();
for (const c of cases) {
	const memory = memoryArg === "live" ? c.memory : memoryArg === "none" ? [] : c.memory.slice(-Number(memoryArg));
	console.log(`\n${c.turns.at(-1)?.content.slice(0, 120)}\n   live: ${c.said.slice(0, 140)}`);
	for (let i = 0; i < Number(repliesArg); i++) {
		const turns = c.turns.slice(-Number(threadArg));
		const heard = turns.at(-1)?.content ?? "";
		const r = postText(bee.reply(withMemory(memory, c.root, turns[0]?.role === "bee" ? turns.slice(1) : turns), Math.random, ctx, Number(candidates), Number(relevance), penaltyFor(heard)));
		const body = r.replace(/^\[[a-z]+:[a-z]+\]\s*/, "");
		const content = new Set((heard.toLowerCase().match(/[a-z]{4,}/g) ?? []).filter((w) => !STOP.has(w)));
		stats.n++; stats.chars += body.length; if (r) stats.garbled += garbleShare(r, heard); seen.add(body);
		if ((body.toLowerCase().match(/[a-z]{4,}/g) ?? []).some((w) => content.has(w))) stats.echo++;
		if (/^\W*yes/i.test(body)) stats.yes++;
		if (r.startsWith("[angry")) stats.angry++;
		console.log(`   -> ${r.slice(0, 200)}`);
	}
}
const pct = (a, b) => `${a}/${b} (${Math.round(100 * a / Math.max(1, b))}%)`;
console.log(`\nSUMMARY ${gguf.split("/").slice(-2).join("/")} memory=${memoryArg} context=${ctx} t=${temperature} n=${candidates} thread=${threadArg} penalty=${garbleArg} relevance=${relevance}: garbled words ${Math.round(100 * stats.garbled / stats.n)}%, echo ${pct(stats.echo, stats.n)}, open with yes ${pct(stats.yes, stats.n)}, angry ${pct(stats.angry, stats.n)}, distinct ${seen.size}/${stats.n}, mean ${Math.round(stats.chars / stats.n)} chars`);
