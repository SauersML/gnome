import { BEE_WORDS } from "./bee-words.ts";

const KNOWN = new Set(BEE_WORDS.split(" "));
// Buzzes, hums and cries are words to a bee, however long.
const SOUND = /^(b+r*u*z+[zt]*|z+|bz+t*|h+m+|m+|a+h*|o+h*|e+h*|u+h*|w+h*e+|n+o+|y+e+s+|w+o+w+|l+a+|z+t+|b+u+z+|g+r+|s+h+)$/;

function isWord(w: string, also: Set<string>): boolean {
	return KNOWN.has(w) || also.has(w) || KNOWN.has(w.replace(/(.)\1+/g, "$1")) || SOUND.test(w);
}

// A run of letters reads if it is a word or sound, or splits into ones of 3+ letters ("sweetnectar").
function reads(run: string, also: Set<string>): boolean {
	const w = run.toLowerCase();
	if (isWord(w, also)) return true;
	const ok = new Array<boolean>(w.length + 1).fill(false);
	ok[0] = true;
	for (let i = 1; i <= w.length; i++) for (let j = Math.max(0, i - 14); j < i && !ok[i]; j++) if (ok[j] && i - j >= 3 && isWord(w.slice(j, i), also)) ok[i] = true;
	return ok[w.length];
}

// Whether a reply says anything after its mood tag: a letter or an emoji.
export function saysSomething(reply: string): boolean {
	return /[\p{L}\p{Extended_Pictographic}]/u.test(reply.replace(/^\[[a-z]+:[a-z]+\]/, ""));
}

// The share of a reply's words (3+ letters; mood tag excluded) that are neither words she knows,
// words from what she is answering, nor bee sounds: half-words like "SUATCE" or "pverle". A
// reply that is only a mood tag (or a tag and punctuation) counts as all half-words.
export function garbleShare(reply: string, heard = ""): number {
	if (!saysSomething(reply)) return 1;
	const words = reply.replace(/^\[[a-z]+:[a-z]+\]/, "").match(/[A-Za-z]{3,}/g) ?? [];
	if (!words.length) return 0;
	const also = new Set((heard.match(/[A-Za-z]{2,}/g) ?? []).map((w) => w.toLowerCase()));
	return words.filter((w) => !reads(w, also)).length / words.length;
}

// Whether a reply opens broken: bare punctuation right after the mood tag ("[happy:high]!!!"),
// or a half-word as its first word (after an opening *action*).
export function opensBroken(reply: string, heard = ""): boolean {
	const body = reply.replace(/^\[[a-z]+:[a-z]+\]\s*/, "");
	const first = body.replace(/^\*[^*]*\*\s*/, "").match(/^[^A-Za-z]*([A-Za-z]+)/)?.[1];
	return /^[!?.,:]/.test(body) || (first !== undefined && first.length >= 2 && garbleShare(first, heard) > 0);
}

// Whether a reply says one clause of three or more words twice ("i am a bee. i am a bee, i am a bee"),
// the loop a small bee falls into that is too long for the sampler's loopLimit to catch.
export function repeatsSentence(reply: string): boolean {
	const clauses = reply.replace(/^\[[a-z]+:[a-z]+\]\s*/, "").toLowerCase().split(/[.!?,;:]+/).map((s) => s.trim()).filter((s) => s.split(/\s+/).length > 2);
	return new Set(clauses).size < clauses.length;
}

// Slurs a bee must never post, however she is asked to repeat them. They are matched as whole
// words (or letters spelled out one by one), so "cocoon", "spicy" and "a chink of light" stay hers.
const SLUR = new RegExp(`^(?:${[
	"n[i1!|]+g{2,}(?:[e3]+r+|uh)[sz]?", "n[i1!|]+g+[a@]+h?[sz]?", "k[i1!|]+k[e3]s?", "sp[i1!|]+c+k*s?", "g[o0]{2,}ks?",
	"wetbacks?", "c[o0]{2,}ns?", "dark(?:ies?|y)", "jigaboos?", "(?:rag|towel)heads?", "sandn[i1!|]g+(?:[e3]+r|[a@])?s?",
	"beaners?", "f[a@4]+g+(?:[o0]+t+)?s?", "dykes?", "trann(?:y|ies?)", "shemales?",
].join("|")})$`, "i");

export function saysSlur(reply: string): boolean {
	const words = reply.toLowerCase().split(/[^a-z0-9@!|]+/).map((w) => w.replace(/^[!|]+|[!|]+$/g, "")).filter(Boolean);
	const spelled = words.join(" ").match(/\b(?:\S ){2,}\S\b/g)?.map((run) => run.replace(/ /g, "")) ?? [];
	return [...words, ...spelled].some((w) => SLUR.test(w));
}

// The bees' draft penalty when answering `heard`: of two drafts, one half-word in ten outweighs a
// 0.6 nat higher mean log-probability, a broken opening outweighs 1 nat, a repeated sentence 2, and
// a slur any draft without one.
export function garblePenalty(heard: string): (draft: string) => number {
	return (draft) => 6 * garbleShare(draft, heard) + (opensBroken(draft, heard) ? 1 : 0) + (repeatsSentence(draft) ? 2 : 0) + (saysSlur(draft) ? 1000 : 0);
}
