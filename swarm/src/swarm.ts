// The bee.gnome.science swarm: six BeeLLM models in one conversation. Each bee hears the
// person in full and only the latest few buzzes of the other bees.
import type { BeeTurn, Sampling } from "../../src/server/bee";
import { garblePenalty, saysSlur } from "../../src/server/garble.ts";

export type SwarmEntry = { who: string; text: string };
// sampling, candidates and relevance are optional per bee (see BeeModel.reply); wholeWords
// prefers drafts without half-words (src/server/garble.ts); cells is how many copies of her
// answer at once (swarm/src/index.ts), for a bee slow enough that people would wait in line, and
// busySeconds each cell's monthly allowance of busy time (src/server/busy.ts).
export type SwarmBee = { id: string; name: string; file: string; maxPromptTokens: number; sampling?: Partial<Sampling>; candidates?: number; relevance?: number; wholeWords?: boolean; cells?: number; busySeconds: number };
type Speaker = {
	chat: boolean;
	reply(turns: BeeTurn[], random?: () => number, maxPromptTokens?: number, candidates?: number, relevance?: number, penalty?: (draft: string) => number): string;
	continueText(text: string, maxTokens: number, random?: () => number): string;
};

export const PERSON = "you";
export const SWARM: SwarmBee[] = [
	// Somnia (train/), the same bee as on delve.town and gnome.science.
	{ id: "somnia", name: "Somnia", file: "BeeLLM-13M-Somnia-Q8_0.gguf", maxPromptTokens: 256, sampling: { temperature: 0.85, firstTemperature: 0.3, loopLimit: 6 }, candidates: 6, relevance: 0.5, wholeWords: true, cells: 4, busySeconds: 100_000 },
	{ id: "melissa", name: "Melissa", file: "BeeLLM-1M-Mood.gguf", maxPromptTokens: 512, busySeconds: 20_000 },
	{ id: "bombus", name: "Bombus", file: "BeeLLM-1M-Mood-Chaos.gguf", maxPromptTokens: 512, busySeconds: 20_000 },
	{ id: "apis", name: "Apis", file: "BeeLLM-42P-Chaos.gguf", maxPromptTokens: 128, busySeconds: 20_000 },
	{ id: "zuzu", name: "Zuzu", file: "BeeLLM-42P.gguf", maxPromptTokens: 128, busySeconds: 20_000 },
	{ id: "bzz", name: "Bzz", file: "BeeLLM-30P.gguf", maxPromptTokens: 128, busySeconds: 20_000 },
];

// How many of the other bees' messages a bee takes in between her own turns.
export const OTHER_BEES_HEARD = 2;
export const TRANSCRIPT_HEARD = 24;
export const MAX_TEXT = 300;
const TINY_BEE_TOKENS = 24;
const TINY_BEE_ATTEMPTS = 5;
const MOOD_TAG = /^\s*\[[a-z]+:[a-z]+\]\s*/i;

const clean = (text: string) => text.replace(MOOD_TAG, "").replace(/\s+/g, " ").trim().slice(0, MAX_TEXT);

// A Mood bee's own messages are her turns. Everything said between them becomes one person
// turn: the person's messages in full, and only the latest few of the other bees' buzzes.
export function moodTurns(beeId: string, transcript: SwarmEntry[]): BeeTurn[] {
	const turns: BeeTurn[] = [];
	let others: { at: number; text: string }[] = [];
	let heard: { at: number; text: string }[] = [];
	const flush = () => {
		heard = [...heard, ...others.slice(-OTHER_BEES_HEARD)].sort((a, b) => a.at - b.at);
		const content = heard.map((h) => h.text).filter(Boolean).join(" ");
		if (content) turns.push({ role: "user", content });
		others = [];
		heard = [];
	};
	transcript.slice(-TRANSCRIPT_HEARD).forEach((e, at) => {
		if (e.who === beeId) {
			flush();
			turns.push({ role: "bee", content: e.text.slice(0, MAX_TEXT) });
		} else if (e.who === PERSON) {
			heard.push({ at, text: clean(e.text) });
		} else {
			others.push({ at, text: clean(e.text) });
		}
	});
	flush();
	return turns;
}

// The tiny bees have no chat template and were trained only on buzzing, so they continue
// the latest buzzes of the swarm (or a single "buzz" before anyone has buzzed).
export function tinyPrompt(transcript: SwarmEntry[]): string {
	const buzzes = transcript.filter((e) => e.who !== PERSON).slice(-OTHER_BEES_HEARD).map((e) => clean(e.text));
	return buzzes.join(" ").slice(-MAX_TEXT) || "buzz";
}

// A bee stays silent rather than repeat a slur she was fed.
export function speak(bee: SwarmBee, model: Speaker, transcript: SwarmEntry[], random: () => number = Math.random): string {
	let text = "";
	if (model.chat) {
		const turns = moodTurns(bee.id, transcript);
		text = model.reply(turns, random, bee.maxPromptTokens, bee.candidates ?? 1, bee.relevance ?? 0, bee.wholeWords ? garblePenalty(turns.at(-1)?.content ?? "") : undefined);
	} else {
		// A Mood bee's silence means something; a tiny bee that stops at once just tries again.
		for (let attempt = 0; attempt < TINY_BEE_ATTEMPTS && !text; attempt++) text = model.continueText(tinyPrompt(transcript), TINY_BEE_TOKENS, random);
	}
	return saysSlur(text) ? "" : text;
}

// Validates an untrusted request body into a bee and a transcript, or returns an error.
export function parseBuzz(body: unknown): { bee: SwarmBee; transcript: SwarmEntry[] } | { error: string } {
	if (!body || typeof body !== "object") return { error: "expected a JSON object" };
	const { bee: beeId, transcript } = body as { bee?: unknown; transcript?: unknown };
	const bee = SWARM.find((b) => b.id === beeId);
	if (!bee) return { error: "unknown bee" };
	if (!Array.isArray(transcript) || transcript.length > 100) return { error: "transcript must be a list of at most 100 messages" };
	const ids = new Set([PERSON, ...SWARM.map((b) => b.id)]);
	const entries: SwarmEntry[] = [];
	for (const e of transcript.slice(-TRANSCRIPT_HEARD)) {
		if (!e || typeof e !== "object" || !ids.has(e.who) || typeof e.text !== "string") return { error: "malformed message" };
		entries.push({ who: e.who, text: e.text.slice(0, MAX_TEXT) });
	}
	return { bee, transcript: entries };
}

// The rate-limit key for an address: an IPv6 host can use every address in its /64.
export function rateKey(ip: string): string {
	if (!ip.includes(":")) return ip;
	const [head, tail = ""] = ip.split("::");
	const h = head ? head.split(":") : [];
	const t = tail ? tail.split(":") : [];
	const groups = ip.includes("::") ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t] : h;
	return groups.slice(0, 4).map((g) => parseInt(g || "0", 16).toString(16)).join(":") + "::/64";
}
