// Pure logic for the delve.town bee agents: what counts as a bee post, what a bee hears and
// remembers, and how often she may speak.
import type { BeeTurn } from "../../src/server/bee";

export type Ref = { uri: string; cid: string };
export type TownPost = Ref & { authorDid: string; handle: string; text: string; createdAt: string; root?: Ref; bot: boolean };
export type Spoken = { at: number; root: string; author: string };
export type Memory = { role: "user" | "bee"; content: string; root: string };

// Terms that make a post about bees, weighted by how surely they mean bees.
const BEE_TERMS: [RegExp, number][] = [
	[/\b(?:bumble ?|honey ?)?bees?\b|🐝|\bbeekeep\w*|\bapiar(?:y|ies|ist)\b|\bwaggle dance\b|\bqueen bee\b/gi, 3],
	[/\bhoney\b|\bhives?\b|\bpollen\b|\bpollinat\w*|\bnectar\b|\bbeeswax\b|\bhoneycomb\b|\bwaggle\b|\bswarm(?:s|ed|ing)?\b/gi, 2],
	[/\bbu+z+\w*|\bbz+\w*|\bflowers?\b/gi, 1],
];
export const SEARCH_TERMS = ["bee", "bees", "honey", "hive", "pollen", "pollinator", "buzz", "waggle", "beekeeping", "nectar", "swarm", "flower", "🐝"];
export const MIN_BEE_SCORE = 3;
// Sentences whose mean embedding is the "bee" direction that posts are compared against.
export const BEE_PROTOTYPES = [
	"bees buzzing from flower to flower",
	"honey bees in their hive making honey from nectar and pollen",
	"a bumblebee landing on a flower in the garden",
	"the waggle dance of a honeybee colony",
	"beekeeping, a queen bee and her swarm",
	"🐝 buzz buzz",
];

export const AMBIENT_EVERY_MS = 5 * 60_000;
export const OWN_POST_EVERY_MS: [number, number] = [40 * 60_000, 80 * 60_000];
export const REACT_EVERY_MS = 6 * 3600_000;
export const MAX_POST_AGE_MS = 3 * 24 * 3600_000;
const HOUR = 3600_000;
// Caps that keep a bee from flooding a thread or trading replies with another bot forever.
export const LIMITS = { perThreadPerHour: 4, perAuthorPerHour: 8, totalPerHour: 30 };
const MAX_POST_CHARS = 290;
const MAX_HEARD_CHARS = 300;

// Interactions without words; she answers each by replying to the person's latest post.
export const REACTIONS = new Set(["like", "repost", "follow"]);

export function beeScore(text: string): number {
	let score = 0;
	for (const [re, weight] of BEE_TERMS) score += (text.match(re)?.length ?? 0) * weight;
	return score;
}

export function cosine(a: number[], b: number[]): number {
	let dot = 0, na = 0, nb = 0;
	for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
	return dot / (Math.sqrt(na * nb) || 1);
}

export function meanVector(vectors: number[][]): number[] {
	return vectors[0].map((_, i) => vectors.reduce((s, v) => s + v[i], 0) / vectors.length);
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

function pushTurn(turns: BeeTurn[], role: BeeTurn["role"], content: string) {
	const last = turns.at(-1);
	if (role === "user" && last?.role === "user") last.content = `${last.content} ${content}`.slice(-MAX_HEARD_CHARS);
	else turns.push({ role, content });
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
		if (text) pushTurn(turns, "user", text);
	}
	return turns;
}

// Her context window: everything she heard and said elsewhere, oldest first, followed by the
// conversation at hand. The model keeps the most recent turns that fit.
export function withMemory(memory: Memory[], root: string, current: BeeTurn[]): BeeTurn[] {
	const turns: BeeTurn[] = [];
	for (const m of memory) if (m.root !== root) pushTurn(turns, m.role, m.content);
	for (const t of current) pushTurn(turns, t.role, t.content);
	return turns;
}

export function allowedToSpeak(spoken: Spoken[], now: number, root: string, author: string): boolean {
	const recent = spoken.filter((s) => now - s.at < HOUR);
	return recent.length < LIMITS.totalPerHour
		&& recent.filter((s) => s.root === root).length < LIMITS.perThreadPerHour
		&& recent.filter((s) => s.author === author).length < LIMITS.perAuthorPerHour;
}

export type Candidate = TownPost & { similarity: number; keywords: number; rank: number };

// Posts she could answer unprompted, best first: anyone's fresh post that is not hers or
// another bee's, not answered, and outside threads she spoke in recently, with the most
// bee-like (by meaning, then words) first.
export function rankAmbient(posts: TownPost[], similarity: Map<string, number>, opts: { self: string; bees: Set<string>; handled: (uri: string) => boolean; spoken: Spoken[]; now: number }): Candidate[] {
	const busyRoots = new Set(opts.spoken.filter((s) => opts.now - s.at < 6 * HOUR).map((s) => s.root));
	const seen = new Set<string>();
	const out: Candidate[] = [];
	for (const p of posts) {
		if (seen.has(p.uri)) continue;
		seen.add(p.uri);
		const age = opts.now - Date.parse(p.createdAt);
		if (p.authorDid === opts.self || opts.bees.has(p.handle) || opts.handled(p.uri)) continue;
		if (!(age >= 0 && age < MAX_POST_AGE_MS) || busyRoots.has((p.root ?? p).uri)) continue;
		const sim = similarity.get(p.uri) ?? 0;
		const keywords = beeScore(p.text);
		out.push({ ...p, similarity: sim, keywords, rank: sim + 0.02 * Math.min(keywords, 15) });
	}
	return out.sort((a, b) => b.rank - a.rank || Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

export function replyRef(post: TownPost) {
	return { root: post.root ?? { uri: post.uri, cid: post.cid }, parent: { uri: post.uri, cid: post.cid } };
}

// Her reply as posted: never tagging anyone ("@sauers.delve.town" becomes "sauers"), within
// the town's length limit.
export function postText(reply: string): string {
	// A reply can end inside a multi-byte character the model only half wrote; drop the remnant.
	const text = reply.replace(/\uFFFD/g, "").replace(/@([a-z0-9-]+)(?:\.[a-z0-9-]+)+/gi, "$1").replace(/[ \t]+/g, " ").trim();
	const chars = Array.from(text);
	return chars.length <= MAX_POST_CHARS ? text : chars.slice(0, MAX_POST_CHARS).join("").trimEnd();
}
