import { DurableObject } from "cloudflare:workers";
import type { BeeModel } from "../../src/server/bee";
import { loadBee } from "../../src/server/bee-assets";
import {
	AMBIENT_EVERY_MS, MAX_POST_AGE_MS, SEARCH_TERMS, type Spoken, type TownPost,
	allowedToSpeak, pickAmbient, postText, replyRef, threadTurns,
} from "./town";

export type TownBee = { id: string; name: string; handle: string; file: string; passwordSecret: string };
type Session = { did: string; handle: string; accessJwt: string; refreshJwt: string };

const PDS = "https://pds.delve.town";
const APPVIEW = "https://api.delve.town";
const APPVIEW_PROXY = "did:web:api.delve.town#bsky_appview";
const POST = "town.delve.feed.post";
const ANSWERED_REASONS = new Set(["mention", "reply", "quote"]);
const MAX_ANSWERS_PER_TICK = 3;
const WRITE_BACKOFF_MS = 30 * 60_000;

class XrpcError extends Error {
	constructor(readonly status: number, readonly code: string, method: string) {
		super(`${method}: HTTP ${status} ${code}`);
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
		const err = await res.json().catch(() => ({})) as { error?: string };
		throw new XrpcError(res.status, err.error ?? "", method);
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

// One bee's account on delve.town: answers whoever talks to her, and otherwise every few
// minutes replies to the most bee-related post she has not answered.
export class BeeAgent extends DurableObject<Env> {
	private model: Promise<BeeModel> | null = null;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		const sql = ctx.storage.sql;
		sql.exec(`CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT)`);
		sql.exec(`CREATE TABLE IF NOT EXISTS handled (uri TEXT PRIMARY KEY, at INTEGER, outcome TEXT)`);
		sql.exec(`CREATE TABLE IF NOT EXISTS spoken (at INTEGER, root TEXT, author TEXT)`);
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
		const since = Date.now() - 24 * 3600_000;
		this.ctx.storage.sql.exec(`DELETE FROM spoken WHERE at < ?`, since);
		return this.ctx.storage.sql.exec(`SELECT at, root, author FROM spoken`).toArray() as Spoken[];
	}

	private async session(bee: TownBee): Promise<Session> {
		const saved = this.get("session");
		let s: Session | null = saved ? JSON.parse(saved) : null;
		if (s && jwtExpiresAt(s.accessJwt) - Date.now() > 5 * 60_000) return s;
		if (s) {
			try {
				s = await xrpc<Session>(PDS, "com.atproto.server.refreshSession", { body: {}, jwt: s.refreshJwt });
			} catch { s = null; }
		}
		if (!s) {
			const password = (this.env as unknown as Record<string, string | undefined>)[bee.passwordSecret];
			if (!password) throw new Error(`${bee.passwordSecret} is not set`);
			s = await xrpc<Session>(PDS, "com.atproto.server.createSession", { body: { identifier: bee.handle, password } });
		}
		this.set("session", JSON.stringify({ did: s.did, handle: s.handle, accessJwt: s.accessJwt, refreshJwt: s.refreshJwt }));
		return s;
	}

	private async thread(uri: string): Promise<TownPost[]> {
		const res = await xrpc<{ thread: any }>(APPVIEW, "town.delve.feed.getPostThread", { query: { uri, depth: "0", parentHeight: "8" } });
		const chain: TownPost[] = [];
		for (let node = res.thread; node?.post; node = node.parent) chain.unshift(toPost(node.post));
		return chain;
	}

	private async speakTo(bee: TownBee, s: Session, post: TownPost): Promise<string> {
		const chain = await this.thread(post.uri);
		const turns = threadTurns(chain.length ? chain : [post], { did: s.did, handle: s.handle, name: bee.name });
		if (!turns.length || turns.at(-1)!.role !== "user") return "nothing to answer";
		this.model ??= loadBee(this.env.ASSETS, bee.file);
		this.model.catch(() => { this.model = null; });
		const reply = postText((await this.model).reply(turns));
		// An empty reply is the bee choosing silence, as BeeLLM sometimes does.
		if (!reply) return "silent";
		await xrpc(PDS, "com.atproto.repo.createRecord", {
			jwt: s.accessJwt,
			body: { repo: s.did, collection: POST, record: { $type: POST, text: reply, reply: replyRef(post), langs: ["en"], createdAt: new Date().toISOString() } },
		});
		this.ctx.storage.sql.exec(`INSERT INTO spoken (at, root, author) VALUES (?, ?, ?)`, Date.now(), (post.root ?? post).uri, post.authorDid);
		this.set("lastPostAt", String(Date.now()));
		console.log(JSON.stringify({ bee: bee.id, replied: post.uri, to: post.handle, text: reply }));
		return "replied";
	}

	// A post that cannot be answered (deleted, blocked, too long) is skipped; losing access
	// (not admitted, suspended, signed out) stops the bee until the backoff passes.
	private async speakOrSkip(bee: TownBee, s: Session, post: TownPost): Promise<string> {
		try {
			return await this.speakTo(bee, s, post);
		} catch (e) {
			if (e instanceof XrpcError && e.status >= 400 && e.status < 500 && ![401, 403, 429].includes(e.status)) return `failed ${e.status} ${e.code}`;
			throw e;
		}
	}

	async tick(bee: TownBee, bees: string[]): Promise<void> {
		const now = Date.now();
		if (Number(this.get("writeBlockedUntil") ?? 0) > now) return;
		const s = await this.session(bee);
		try {
			let answered = 0;
			const notes = await xrpc<{ notifications: any[] }>(PDS, "town.delve.notification.listNotifications", { query: { limit: "40" }, jwt: s.accessJwt, proxy: true });
			const pending = notes.notifications
				.filter((n) => ANSWERED_REASONS.has(n.reason) && n.author?.did !== s.did && !this.handled(n.uri)
					&& now - Date.parse(n.indexedAt) < MAX_POST_AGE_MS)
				.reverse();
			for (const n of pending) {
				if (answered >= MAX_ANSWERS_PER_TICK) break;
				const post = toPost({ ...n, record: n.record });
				if (!allowedToSpeak(this.spoken(), Date.now(), (post.root ?? post).uri, post.authorDid)) {
					this.markHandled(n.uri, "over limit");
					continue;
				}
				const outcome = await this.speakOrSkip(bee, s, post);
				this.markHandled(n.uri, outcome);
				if (outcome === "replied") answered++;
			}
			if (pending.length) await xrpc(PDS, "town.delve.notification.updateSeen", { body: { seenAt: new Date().toISOString() }, jwt: s.accessJwt, proxy: true });
			if (answered || pending.length > answered) return;

			if (now - Number(this.get("lastPostAt") ?? 0) < AMBIENT_EVERY_MS) return;
			const found: TownPost[] = [];
			for (const q of SEARCH_TERMS) {
				const res = await xrpc<{ posts: any[] }>(APPVIEW, "town.delve.feed.searchPosts", { query: { q, limit: "25", sort: "latest" } }).catch(() => ({ posts: [] }));
				found.push(...res.posts.map(toPost));
			}
			const target = pickAmbient(found, { self: s.did, bees: new Set(bees), handled: (u) => this.handled(u), spoken: this.spoken(), now });
			if (!target) return;
			if (!allowedToSpeak(this.spoken(), now, (target.root ?? target).uri, target.authorDid)) return;
			this.markHandled(target.uri, await this.speakOrSkip(bee, s, target));
		} catch (e) {
			if (e instanceof XrpcError && (e.status === 401 || e.status === 403)) {
				// Wait instead of retrying every minute, and sign in afresh next time.
				this.set("writeBlockedUntil", String(Date.now() + WRITE_BACKOFF_MS));
				this.ctx.storage.sql.exec(`DELETE FROM kv WHERE key = 'session'`);
			}
			throw e;
		}
	}
}
