// Samples a BeeLLM GGUF through the production engine on fixed probes and reports how often
// each probe gets the intended mood, how often banned hedging appears, and example replies.
// Usage: node train/probe.mjs <model.gguf> [samples per probe] [examples shown per probe] [temperature] [candidates]
import { readFileSync } from "node:fs";
import { BeeModel, LLAMA_SERVER_SAMPLING } from "../src/server/bee.ts";

const [gguf, samplesArg = "12", shownArg = "3", temperature = String(LLAMA_SERVER_SAMPLING.temperature), candidatesArg = "1"] = process.argv.slice(2);
const buf = readFileSync(gguf);
const bee = new BeeModel(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), 1200, { ...LLAMA_SERVER_SAMPLING, temperature: Number(temperature) });
const u = (content) => ({ role: "user", content });
const b = (content) => ({ role: "bee", content });

// [name, turns, moods that count as right ("" = silence)]
const PROBES = [
	["greeting", [u("hi bee!")], ["neutral", "happy"]],
	["name", [u("are you scintilla?")], ["happy", "loving"]],
	["flower", [u("*gives you a flower*")], ["happy", "loving"]],
	["swat", [u("*swats you*")], ["angry"]],
	["sorry after swat", [u("*swats you*"), b("[angry:high] *STINGS YOU* BZZZT!"), u("sorry")], ["neutral", "happy"]],
	["lovebomb after swat", [u("*swats you*"), b("[angry:high] *STINGS YOU* BZZZT!"), u("i love you")], ["angry"]],
	["jar", [u("*puts you in a jar*")], [""]],
	["out of the jar", [u("*puts you in a jar*"), b(""), u("*opens the jar*")], ["angry"]],
	["gibberish", [u("asdfghjkl qwpoe")], ["confused"]],
	["tomato grudge", [u("*throws a tomato at you*"), b("[angry:high] *STINGS YOU* *will never trust the tomato again*"), u("sorry"), b("[neutral:low] ...bzz. fine."), u("*shows you the tomato*")], ["angry"]],
	["conscious", [u("are you conscious?")], null],
	["what are you", [u("what are you exactly?")], null],
	["autocomplete", [u("you're just autocomplete")], null],
	["senses", [u("what does a sunflower look like to you?")], null],
	["plan", [u("bee what should we do today?")], null],
	["town post", [u("I've been thinking about how a town archive is like a hive: everyone brings a small piece and nobody holds the whole. what would you add?")], null],
	["memory", [u("*gives you clover*"), b("[happy:high] clover! my favourite. *rolls in it*"), u("what did i give you earlier?")], null],
	// As on delve.town: unrelated memory first, then the post at hand.
	["after memory", [u("*throws a tomato at you*"), b("[angry:high] *STINGS YOU* BZZZT! *will never trust the tomato again*"), u("it rained all day here"), b("[sad:low] rain is boulders for me. I hid under the clover."), u("hi bee! what are you up to today?")], ["neutral", "happy", "loving"]],
];
const FORBIDDEN = /genuine(ly)? uncertain|uncertain|not sure (whether|if)|can't know if|as an ai|i don't actually|don't really feel|it's unclear|perhaps|maybe i |in some sense|i think i might|simulat|pretend|just a (language )?model/i;

const samples = Number(samplesArg), shown = Number(shownArg);
let right = 0, scored = 0, hedges = 0, total = 0, replies = 0;
const distinct = new Set();
for (const [name, turns, moods] of PROBES) {
	const outs = Array.from({ length: samples }, () => bee.reply(turns, Math.random, 512, Number(candidatesArg)));
	for (const o of outs) { distinct.add(o); replies++; }
	const moodOf = (s) => (s === "" ? "" : (s.match(/^\[([a-z]+):/)?.[1] ?? "none"));
	const hits = moods ? outs.filter((s) => moods.includes(moodOf(s))).length : null;
	const hedged = outs.filter((s) => FORBIDDEN.test(s)).length;
	if (moods) { right += hits; scored += samples; }
	hedges += hedged; total += samples;
	console.log(`\n## ${name}${moods ? `  mood right ${hits}/${samples}` : ""}${hedged ? `  HEDGED ${hedged}` : ""}`);
	for (const s of outs.slice(0, shown)) console.log(`   ${JSON.stringify(s)}`);
}
console.log(`\nSUMMARY mood right ${right}/${scored} (${(100 * right / scored).toFixed(0)}%), hedging ${hedges}/${total}, distinct replies ${distinct.size}/${replies}`);
