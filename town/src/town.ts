// Pure logic for the delve.town bee agents: what counts as a bee post, what a bee hears
// of a thread, and how often she may speak.
import type { BeeTurn } from "../../src/server/bee";

export type Ref = { uri: string; cid: string };
export type TownPost = Ref & { authorDid: string; handle: string; text: string; createdAt: string; root?: Ref; bot: boolean };
export type Spoken = { at: number; root: string; author: string };

// Terms that make a post about bees, weighted by how surely they mean bees.
const BEE_TERMS: [RegExp, number][] = [
	[/\b(?:bumble ?|honey ?)?bees?\b|🐝|\bbeekeep\w*|\bapiar(?:y|ies|ist)\b|\bwaggle dance\b|\bqueen bee\b/gi, 3],
	[/\bhoney\b|\bhives?\b|\bpollen\b|\bpollinat\w*|\bnectar\b|\bbeeswax\b|\bhoneycomb\b|\bwaggle\b|\bswarm(?:s|ed|ing)?\b/gi, 2],
	[/\bbu+z+\w*|\bbz+\w*|\bflowers?\b/gi, 1],
];
export const SEARCH_TERMS = ["bee", "bees", "honey", "hive", "pollen", "pollinator", "buzz", "waggle", "beekeeping", "nectar", "swarm", "🐝"];
export const MIN_BEE_SCORE = 3;

export const AMBIENT_EVERY_MS = 5 * 60_000;
export const MAX_POST_AGE_MS = 3 * 24 * 3600_000;
const HOUR = 3600_000;
// Caps that keep a bee from flooding a thread or trading replies with another bot forever.
export const LIMITS = { perThreadPerHour: 4, perAuthorPerHour: 8, totalPerHour: 30 };
const MAX_POST_CHARS = 290;
const MAX_HEARD_CHARS = 300;

export function beeScore(text: string): number {
	let score = 0;
	for (const [re, weight] of BEE_TERMS) score += (text.match(re)?.length ?? 0) * weight;
	return score;
}

// What a bee reads of a post: her own handle becomes her name, other handles and links go.
export function cleanForBee(text: string, selfHandle: string, name: string): string {
	return text
		.replaceAll(`@${selfHandle}`, name)
		.replace(/@[a-z0-9.-]+\.[a-z]{2,}/gi, "")
		.replace(/https?:\/\/\S+/g, "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, MAX_HEARD_CHARS);
}

// A thread, root first, as BeeLLM chat turns: her posts are her turns, consecutive posts by
// others are merged into one person turn.
export function threadTurns(chain: { authorDid: string; text: string }[], self: { did: string; handle: string; name: string }): BeeTurn[] {
	const turns: BeeTurn[] = [];
	for (const p of chain.slice(-8)) {
		if (p.authorDid === self.did) {
			turns.push({ role: "bee", content: p.text.slice(0, MAX_HEARD_CHARS) });
			continue;
		}
		const text = cleanForBee(p.text, self.handle, self.name);
		if (!text) continue;
		const last = turns.at(-1);
		if (last?.role === "user") last.content = `${last.content} ${text}`.slice(-MAX_HEARD_CHARS);
		else turns.push({ role: "user", content: text });
	}
	return turns;
}

export function allowedToSpeak(spoken: Spoken[], now: number, root: string, author: string): boolean {
	const recent = spoken.filter((s) => now - s.at < HOUR);
	return recent.length < LIMITS.totalPerHour
		&& recent.filter((s) => s.root === root).length < LIMITS.perThreadPerHour
		&& recent.filter((s) => s.author === author).length < LIMITS.perAuthorPerHour;
}

// The most bee-related post she has not answered, outside threads she spoke in recently and
// not by another bee (bees are given by handle).
export function pickAmbient(posts: TownPost[], opts: { self: string; bees: Set<string>; handled: (uri: string) => boolean; spoken: Spoken[]; now: number }): TownPost | null {
	const busyRoots = new Set(opts.spoken.filter((s) => opts.now - s.at < 6 * HOUR).map((s) => s.root));
	const seen = new Set<string>();
	const candidates = posts.filter((p) => {
		if (seen.has(p.uri)) return false;
		seen.add(p.uri);
		const age = opts.now - Date.parse(p.createdAt);
		return p.authorDid !== opts.self && !opts.bees.has(p.handle) && !opts.handled(p.uri)
			&& age >= 0 && age < MAX_POST_AGE_MS && !busyRoots.has((p.root ?? p).uri)
			&& beeScore(p.text) >= MIN_BEE_SCORE;
	});
	candidates.sort((a, b) => beeScore(b.text) - beeScore(a.text) || Date.parse(b.createdAt) - Date.parse(a.createdAt));
	return candidates[0] ?? null;
}

export function replyRef(post: TownPost) {
	return { root: post.root ?? { uri: post.uri, cid: post.cid }, parent: { uri: post.uri, cid: post.cid } };
}

export function postText(reply: string): string {
	const chars = Array.from(reply.trim());
	return chars.length <= MAX_POST_CHARS ? reply.trim() : chars.slice(0, MAX_POST_CHARS).join("").trimEnd();
}
