import { DurableObject } from "cloudflare:workers";
import type { BeeModel, BeeTurn, Sampling } from "../../src/server/bee";
import { MAX_REPLY_TOKENS } from "../../src/server/bee";
import { loadBee } from "../../src/server/bee-assets";
import {
	AMBIENT_EVERY_MS, BEE_PROTOTYPES, MAX_POST_AGE_MS, OWN_POST_EVERY_MS, REACTIONS, REACT_EVERY_MS, SEARCH_TERMS,
	type Memory, type Spoken, type TownPost,
	allowedToSpeak, cleanForBee, cosine, meanVector, mentionPost, postText, rankAmbient, replyRef, threadTurns, withMemory,
} from "./town";

// sampling and candidates (replies sampled per prompt, the most fluent kept) suit each model.
export type TownBee = { id: string; name: string; handle: string; file: string; passwordSecret: string; sampling: Sampling; candidates: number };
type Session = { did: string; handle: string; accessJwt: string; refreshJwt: string };

const PDS = "https://pds.delve.town";
const APPVIEW = "https://api.delve.town";
const APPVIEW_PROXY = "did:web:api.delve.town#bsky_appview";
const TOWN_FEED = "at://did:plc:qzqct2rrq4u2gmy5g3mjxske/town.delve.feed.generator/town";
const POST = "town.delve.feed.post";
const EMBED_MODEL = "@cf/baai/bge-base-en-v1.5";
const TALK_REASONS = new Set(["mention", "reply", "quote"]);
// Her context window, in tokens of the prompt; the 12M model was trained on up to 4096.
const CONTEXT_TOKENS = 768;
const MEMORY_ROWS = 200;
const MAX_ACTIONS_PER_TICK = 2;
const PAUSE_MS = 15 * 60_000;

class XrpcError extends Error {
	constructor(readonly status: number, readonly code: string, method: string, detail = "") {
		super(`${method}: HTTP ${status} ${code} ${detail}`.trim());
	}
}

async function xrpc<T>(base: string, method: string, opts: { query?: Record<string, string>; body?: unknown; jwt?: string; proxy?: boolean } = {}): Promise<T> {
	const url = new URL(`/xrpc/${method}`, base);
	for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
	const headers: Record<string, string> = {};
	if (opts.jwt) headers.authorization = `Bearer ${opts.jwt}`;
	if (opts.proxy) headers["atproto-proxy"] = APPVIEW_PROXY;
	if (opts.body !== undefined) headers["content-type"] = "application/json";
	const res = await fetch(url, { method: opts.body === undefined ? "GET" : "POST", headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
	if (!res.ok) {
		const err = await res.json().catch(() => ({})) as { error?: string; message?: string };
		throw new XrpcError(res.status, err.error ?? "", method, err.message?.slice(0, 200));
	}
	return (res.headers.get("content-type")?.includes("json") ? res.json() : {}) as Promise<T>;
}

function jwtExpiresAt(jwt: string): number {
	try { return JSON.parse(atob(jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).exp * 1000; } catch { return 0; }
}

function toPost(p: any): TownPost {
	return {
		uri: p.uri, cid: p.cid, authorDid: p.author.did, handle: p.author.handle,
		text: typeof p.record?.text === "string" ? p.record.text : "",
		createdAt: p.record?.createdAt ?? p.indexedAt, root: p.record?.reply?.root,
		bot: (p.author.labels ?? []).some((l: { val: string }) => l.val === "bot"),
	};
}

const snippet = (text: string) => text.replace(/\s+/g, " ").slice(0, 80);

// One bee's account on delve.town, run every minute. She answers whoever talks to her, reacts
// to likes, reposts and follows, posts her own buzz about once an hour, and otherwise every
// few minutes replies to the most bee-like post she has not answered. Everything she hears
// and says goes into her memory, which forms the start of every prompt.
export class BeeAgent extends DurableObject<Env> {
	private model: Promise<BeeModel> | null = null;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		const sql = ctx.storage.sql;
		sql.exec(`CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT)`);
		sql.exec(`CREATE TABLE IF NOT EXISTS handled (uri TEXT PRIMARY KEY, at INTEGER, outcome TEXT)`);
		sql.exec(`CREATE TABLE IF NOT EXISTS spoken (at INTEGER, root TEXT, author TEXT)`);
		sql.exec(`CREATE TABLE IF NOT EXISTS memory (at INTEGER, role TEXT, content TEXT, root TEXT)`);
		sql.exec(`CREATE TABLE IF NOT EXISTS similarity (uri TEXT PRIMARY KEY, at INTEGER, value REAL)`);
	}

	private get(key: string): string | null {
		return (this.ctx.storage.sql.exec(`SELECT value FROM kv WHERE key = ?`, key).toArray()[0]?.value as string) ?? null;
	}
	private set(key: string, value: string) {
		this.ctx.storage.sql.exec(`INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`, key, value);
	}
	private handled(uri: string): boolean {
		return this.ctx.storage.sql.exec(`SELECT 1 FROM handled WHERE uri = ?`, uri).toArray().length > 0;
	}
	private markHandled(uri: string, outcome: string) {
		this.ctx.storage.sql.exec(`INSERT OR REPLACE INTO handled (uri, at, outcome) VALUES (?, ?, ?)`, uri, Date.now(), outcome);
	}
	private spoken(): Spoken[] {
		this.ctx.storage.sql.exec(`DELETE FROM spoken WHERE at < ?`, Date.now() - 24 * 3600_000);
		return this.ctx.storage.sql.exec(`SELECT at, root, author FROM spoken`).toArray() as Spoken[];
	}
	private memory(): Memory[] {
		return this.ctx.storage.sql.exec(`SELECT role, content, root FROM memory ORDER BY at`).toArray() as Memory[];
	}
	private remember(root: string, heard: string, said: string) {
		const at = Date.now();
		this.ctx.storage.sql.exec(`INSERT INTO memory (at, role, content, root) VALUES (?, 'user', ?, ?), (?, 'bee', ?, ?)`, at, heard, root, at + 1, said, root);
		this.ctx.storage.sql.exec(`DELETE FROM memory WHERE at NOT IN (SELECT at FROM memory ORDER BY at DESC LIMIT ?)`, MEMORY_ROWS);
	}

	private async session(bee: TownBee): Promise<Session> {
		const saved = this.get("session");
		let s: Session | null = saved ? JSON.parse(saved) : null;
		if (s && jwtExpiresAt(s.accessJwt) - Date.now() > 5 * 60_000) return s;
		if (s) {
			try { s = await xrpc<Session>(PDS, "com.atproto.server.refreshSession", { body: {}, jwt: s.refreshJwt }); } catch { s = null; }
		}
		if (!s) {
			const password = (this.env as unknown as Record<string, string | undefined>)[bee.passwordSecret];
			if (!password) throw new Error(`${bee.passwordSecret} is not set`);
			s = await xrpc<Session>(PDS, "com.atproto.server.createSession", { body: { identifier: bee.handle, password } });
		}
		this.set("session", JSON.stringify({ did: s.did, handle: s.handle, accessJwt: s.accessJwt, refreshJwt: s.refreshJwt }));
		return s;
	}

	// Generates her reply to a conversation, preceded by her memory of everything else.
	private async buzz(bee: TownBee, root: string, turns: BeeTurn[]): Promise<string> {
		this.model ??= loadBee(this.env.ASSETS, bee.file, CONTEXT_TOKENS + MAX_REPLY_TOKENS, bee.sampling);
		this.model.catch(() => { this.model = null; });
		return postText((await this.model).reply(withMemory(this.memory(), root, turns), Math.random, CONTEXT_TOKENS, bee.candidates));
	}

	private async createPost(s: Session, record: Record<string, unknown>) {
		await xrpc(PDS, "com.atproto.repo.createRecord", {
			jwt: s.accessJwt,
			body: { repo: s.did, collection: POST, record: { $type: POST, ...record, langs: ["en"], createdAt: new Date().toISOString() } },
		});
		this.set("lastPostAt", String(Date.now()));
	}

	private async thread(uri: string): Promise<TownPost[]> {
		const res = await xrpc<{ thread: any }>(APPVIEW, "town.delve.feed.getPostThread", { query: { uri, depth: "0", parentHeight: "8" } });
		const chain: TownPost[] = [];
		for (let node = res.thread; node?.post; node = node.parent) chain.unshift(toPost(node.post));
		return chain;
	}

	// Replies in the thread of a post that talks to her (or that she chose to answer).
	private async talk(bee: TownBee, s: Session, post: TownPost): Promise<string> {
		const root = (post.root ?? post).uri;
		if (!allowedToSpeak(this.spoken(), Date.now(), root, post.authorDid)) return "over limit";
		const chain = await this.thread(post.uri);
		const turns = threadTurns(chain.length ? chain : [post], { did: s.did, handle: s.handle, name: bee.name });
		const heard = turns.at(-1);
		if (heard?.role !== "user") return "nothing to answer";
		const reply = await this.buzz(bee, root, turns);
		// An empty reply is the bee choosing silence, as BeeLLM sometimes does.
		if (!reply) return "silent";
		await this.createPost(s, { text: reply, reply: replyRef(post) });
		this.ctx.storage.sql.exec(`INSERT INTO spoken (at, root, author) VALUES (?, ?, ?)`, Date.now(), root, post.authorDid);
		this.remember(root, heard.content, reply);
		console.log(JSON.stringify({ bee: bee.id, replied: post.uri, to: post.handle, heard: snippet(heard.content), said: reply }));
		return "replied";
	}

	// Likes, reposts and follows get a post addressed to the person; follows are followed back.
	private async react(bee: TownBee, s: Session, n: any): Promise<string> {
		const did: string = n.author.did;
		const recent = this.spoken().some((x) => x.root === "reaction" && x.author === did && Date.now() - x.at < REACT_EVERY_MS);
		if (n.reason === "follow" && !n.author.viewer?.following) {
			await xrpc(PDS, "com.atproto.repo.createRecord", {
				jwt: s.accessJwt,
				body: { repo: s.did, collection: "town.delve.graph.follow", record: { $type: "town.delve.graph.follow", subject: did, createdAt: new Date().toISOString() } },
			});
		}
		if (recent) return n.reason === "follow" ? "followed back" : "already reacted";
		const heard = REACTIONS[n.reason];
		const reply = await this.buzz(bee, `reaction:${did}`, [{ role: "user", content: heard }]);
		if (!reply) return "silent";
		await this.createPost(s, mentionPost(n.author.handle, did, reply));
		this.ctx.storage.sql.exec(`INSERT INTO spoken (at, root, author) VALUES (?, 'reaction', ?)`, Date.now(), did);
		this.remember(`reaction:${did}`, heard, reply);
		console.log(JSON.stringify({ bee: bee.id, reacted: n.reason, to: n.author.handle, said: reply }));
		return "reacted";
	}

	private async townPosts(): Promise<TownPost[]> {
		const posts: TownPost[] = [];
		const feed = await xrpc<{ feed: any[] }>(APPVIEW, "town.delve.feed.getFeed", { query: { feed: TOWN_FEED, limit: "60" } }).catch(() => ({ feed: [] }));
		posts.push(...feed.feed.map((f) => toPost(f.post)));
		for (const q of SEARCH_TERMS) {
			const res = await xrpc<{ posts: any[] }>(APPVIEW, "town.delve.feed.searchPosts", { query: { q, limit: "25", sort: "latest" } }).catch(() => ({ posts: [] }));
			posts.push(...res.posts.map(toPost));
		}
		return posts;
	}

	private async embed(text: string[]): Promise<number[][]> {
		const out = await this.env.AI.run(EMBED_MODEL, { text });
		if (!("data" in out) || !out.data) throw new Error("embedding returned no vectors");
		return out.data;
	}

	// Cosine similarity of each post to the mean embedding of BEE_PROTOTYPES, cached per post.
	private async similarity(posts: TownPost[]): Promise<Map<string, number>> {
		const sql = this.ctx.storage.sql;
		sql.exec(`DELETE FROM similarity WHERE at < ?`, Date.now() - MAX_POST_AGE_MS - 24 * 3600_000);
		const known = new Map((sql.exec(`SELECT uri, value FROM similarity`).toArray() as { uri: string; value: number }[]).map((r) => [r.uri, r.value]));
		const fresh = [...new Map(posts.filter((p) => !known.has(p.uri) && p.text.trim()).map((p) => [p.uri, p])).values()];
		if (fresh.length) {
			const saved = this.get("beeVector");
			let bee: number[];
			if (saved) bee = JSON.parse(saved);
			else {
				bee = meanVector(await this.embed(BEE_PROTOTYPES));
				this.set("beeVector", JSON.stringify(bee));
			}
			for (let i = 0; i < fresh.length; i += 50) {
				const batch = fresh.slice(i, i + 50);
				const vectors = await this.embed(batch.map((p) => p.text.slice(0, 1000)));
				batch.forEach((p, j) => {
					const value = cosine(vectors[j], bee);
					known.set(p.uri, value);
					sql.exec(`INSERT OR REPLACE INTO similarity (uri, at, value) VALUES (?, ?, ?)`, p.uri, Date.now(), value);
				});
			}
		}
		return known;
	}

	private async ambient(bee: TownBee, s: Session, bees: string[]): Promise<unknown> {
		const posts = await this.townPosts();
		const ranked = rankAmbient(posts, await this.similarity(posts), { self: s.did, bees: new Set(bees), handled: (u) => this.handled(u), spoken: this.spoken(), now: Date.now() });
		const top = ranked.slice(0, 3).map((c) => ({ to: c.handle, similarity: +c.similarity.toFixed(3), keywords: c.keywords, text: snippet(c.text) }));
		for (const c of ranked.slice(0, 3)) {
			const outcome = await this.talk(bee, s, c);
			this.markHandled(c.uri, outcome);
			if (outcome === "replied") return { candidates: ranked.length, top };
		}
		return { candidates: ranked.length, top, replied: false };
	}

	// Her own top-level buzz, prompted by the latest thing she read in the town.
	private async ownPost(bee: TownBee, s: Session): Promise<unknown> {
		const feed = await xrpc<{ feed: any[] }>(APPVIEW, "town.delve.feed.getFeed", { query: { feed: TOWN_FEED, limit: "20" } });
		const latest = feed.feed.map((f) => toPost(f.post)).find((p) => p.authorDid !== s.did && cleanForBee(p.text, s.handle, bee.name));
		const heard = latest ? cleanForBee(latest.text, s.handle, bee.name) : "hi bee";
		const reply = await this.buzz(bee, "own", [{ role: "user", content: heard }]);
		if (!reply) return { silent: true };
		await this.createPost(s, { text: reply });
		this.remember("own", heard, reply);
		return { heard: snippet(heard), said: reply };
	}

	async tick(bee: TownBee, bees: string[]): Promise<void> {
		const now = Date.now();
		const pausedUntil = Number(this.get("pausedUntil") ?? 0);
		if (pausedUntil > now) {
			console.log(JSON.stringify({ bee: bee.id, paused: this.get("pausedReason"), until: new Date(pausedUntil).toISOString() }));
			return;
		}
		const summary: Record<string, unknown> = { bee: bee.id };
		try {
			const s = await this.session(bee);
			const notes = await xrpc<{ notifications: any[] }>(PDS, "town.delve.notification.listNotifications", { query: { limit: "50" }, jwt: s.accessJwt, proxy: true });
			const pending = notes.notifications
				.filter((n) => n.author?.did !== s.did && !this.handled(n.uri) && now - Date.parse(n.indexedAt) < MAX_POST_AGE_MS)
				.reverse();
			let actions = 0;
			for (const n of pending) {
				if (actions >= MAX_ACTIONS_PER_TICK) break;
				let outcome: string;
				try {
					if (TALK_REASONS.has(n.reason)) outcome = await this.talk(bee, s, toPost(n));
					else if (REACTIONS[n.reason]) outcome = await this.react(bee, s, n);
					else outcome = `ignored ${n.reason}`;
				} catch (e) {
					// A post that cannot be answered (deleted, blocked) is skipped; losing access is not.
					if (!(e instanceof XrpcError) || e.status === 401 || e.status === 403 || e.status === 429 || e.status >= 500) throw e;
					outcome = `failed ${e.message}`;
				}
				this.markHandled(n.uri, outcome);
				if (outcome === "replied" || outcome === "reacted") actions++;
				summary[n.reason] = ((summary[n.reason] as number) ?? 0) + 1;
			}
			if (pending.length) await xrpc(PDS, "town.delve.notification.updateSeen", { body: { seenAt: new Date().toISOString() }, jwt: s.accessJwt, proxy: true });
			const waiting = pending.filter((n) => !this.handled(n.uri)).length;
			if (actions || waiting) {
				console.log(JSON.stringify({ ...summary, actions, waiting }));
				return;
			}
			if (now >= Number(this.get("nextOwnPostAt") ?? 0)) {
				summary.own = await this.ownPost(bee, s);
				const [lo, hi] = OWN_POST_EVERY_MS;
				this.set("nextOwnPostAt", String(Date.now() + lo + Math.random() * (hi - lo)));
			} else if (now - Number(this.get("lastPostAt") ?? 0) >= AMBIENT_EVERY_MS) {
				summary.ambient = await this.ambient(bee, s, bees);
			}
			console.log(JSON.stringify(summary));
		} catch (e) {
			if (e instanceof XrpcError && (e.status === 401 || e.status === 403)) {
				// Signed out, suspended or refused: wait, then sign in afresh.
				this.set("pausedUntil", String(Date.now() + PAUSE_MS));
				this.set("pausedReason", e.message);
				this.ctx.storage.sql.exec(`DELETE FROM kv WHERE key = 'session'`);
			}
			throw e;
		}
	}
}
