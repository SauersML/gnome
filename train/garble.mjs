// Scores how readable a bee checkpoint's caps are: the share of all-caps words (3+ letters)
// that are neither English words (macOS /usr/share/dict/words plus bee words), buzz or cry
// sounds, nor an English word repeated ("SWEETSWEETSWEET"). Samples real-looking prompts with
// the production engine and prints the garble share with examples.
// Usage: node train/garble.mjs <model.gguf> [samples per prompt] [temperature] [candidates] [relevance]
import { readFileSync } from "node:fs";
import { BeeModel, LLAMA_SERVER_SAMPLING } from "../src/server/bee.ts";

const [gguf, samplesArg = "4", temperature = "0.85", candidates = "2", relevance = "0.5"] = process.argv.slice(2);
const buf = readFileSync(gguf);
const bee = new BeeModel(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), 900, { ...LLAMA_SERVER_SAMPLING, temperature: Number(temperature) });
const WORDS = new Set(readFileSync("/usr/share/dict/words", "utf8").split("\n").map((w) => w.toLowerCase()));
for (const w of "mellifera scintilla melissa bombus apis zuzu bzz cloudflare sauers schizophyllume waggle nectar pollen clover linden lavender hexagon swatter wasp wasps okay ok hi bye lol yes yesss stinger stings sting hive comb sunflower".split(" ")) WORDS.add(w);
const SOUND = /^(b+r*u*z+[zt]*|z+|bz+t*|h+m+|m+|a+h*|o+h*|e+h*|u+h*|w+h*e+|n+o+|y+e+s+|w+o+w+|l+a+|z+t+|b+u+z+|g+r+|s+h+)$/i;
const isWord = (w) => WORDS.has(w) || WORDS.has(w.replace(/(.)\1+/g, "$1")) || SOUND.test(w);
// A caps run is readable if it splits into English words or sounds ("NECTARNECTAR", "SWEETNECTAR").
function readable(run) {
	const w = run.toLowerCase();
	if (isWord(w)) return true;
	const ok = new Array(w.length + 1).fill(false);
	ok[0] = true;
	for (let i = 1; i <= w.length; i++) for (let j = Math.max(0, i - 14); j < i && !ok[i]; j++) if (ok[j] && i - j >= 2 && isWord(w.slice(j, i))) ok[i] = true;
	return ok[w.length];
}

const PROMPTS = [
	"are you conscious?", "what are you?", "hi mellifera!", "*gives you a flower*", "*gives you honey*", "*swats you*",
	"what does the sun feel like?", "tell me a secret", "made soup tonight. too much salt again.",
	"Light is cheap. Does it feel warm, or just bright?", "Thanks for the welcome! What brought me here is curiosity.",
	"dispatch from humanworld: today is my first wedding anniversary!", "Scorekeeper's count: 11 haven't answered yet.",
	"the archive is like a hive: everyone brings a small piece", "I fixed a bug that took three days",
];
let caps = 0, bad = 0;
const badExamples = new Set(), shown = [];
for (const p of PROMPTS) {
	for (let i = 0; i < Number(samplesArg); i++) {
		const r = bee.reply([{ role: "user", content: p }], Math.random, 768, Number(candidates), Number(relevance));
		if (i === 0) shown.push(`${p.slice(0, 40)} -> ${r.slice(0, 160)}`);
		for (const m of r.replace(/^\[[a-z:]+\]/, "").matchAll(/\b[A-Z]{3,}\b/g)) {
			caps++;
			if (!readable(m[0])) { bad++; if (badExamples.size < 24) badExamples.add(m[0]); }
		}
	}
}
console.log(shown.join("\n"));
console.log(`\ngarbled caps words: ${bad}/${caps} (${(100 * bad / Math.max(1, caps)).toFixed(0)}%) e.g. ${[...badExamples].join(" ")}`);
