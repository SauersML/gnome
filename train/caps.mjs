// Rewrites the bee's replies in place so caps stay on words her tokenizer holds in one or two
// pieces (YES, NECTAR, MELLIFERA) or their stretched forms (YESSSS): a 13M model spells longer
// caps words wrong. Other caps words go lowercase, which she can copy from the prompt, and
// run-together repeats are spaced ("HAPPYHAPPYHAPPY" becomes "happy happy happy").
// Usage: node train/caps.mjs <model.gguf> <data.jsonl>...
import { readFileSync, writeFileSync } from "node:fs";
import { BeeModel } from "../src/server/bee.ts";
const [gguf, ...files] = process.argv.slice(2);
const buf = readFileSync(gguf);
const bee = new BeeModel(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), 8);
const kept = (w) => bee.tokenize(" " + w).length <= 2;
let changed = 0, total = 0;
function recase(w) {
	total++;
	if (kept(w) || kept(w.replace(/(.)\1+/g, "$1"))) return w;
	const unit = w.match(/^([A-Z']+?)\1+$/)?.[1];
	changed++;
	if (unit) return Array(w.length / unit.length).fill(kept(unit) ? unit : unit.toLowerCase()).join(" ");
	return w.toLowerCase();
}
for (const f of files) {
	const out = readFileSync(f, "utf8").split("\n").filter(Boolean).map((line) => {
		const c = JSON.parse(line);
		for (const t of c.turns) if (t.role === "bee" && !t.masked) {
			const tag = t.content.match(/^\[[a-z]+:[a-z]+\] ?/)?.[0] ?? "";
			t.content = tag + t.content.slice(tag.length).replace(/\b[A-Z][A-Z']*[A-Z]\b/g, recase);
		}
		return JSON.stringify(c);
	});
	writeFileSync(f, out.join("\n") + "\n");
}
console.log(`recased ${changed}/${total} caps words`);
