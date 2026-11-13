import { liveMetrics, type MetricsBindings } from "./live-metrics";
import { oracleChat } from "./oracle-chat";

// Hidden pages under /p/<slug>/: static files from public/p/<slug>/ (git-ignored), sent with headers that keep them out of
// search engines, plus dynamic parts that live outside git:
//   /p/<slug>/live.json      a JSON document a scheduled job writes to the PAGES namespace under "<slug>/live.json"
//                            (by wrangler from the Mac, or by PUT with "Authorization: Bearer <LIVE_WRITE>" from a pod,
//                            so the page stays live with the Mac offline; the secret can write this one key and nothing else)
//   /p/<slug>/live/index.json  the same document with each run replaced by {"v": <hash>}, under "<slug>/live/index.json";
//                            sent with an ETag, so an unchanged poll is a 304. A pod's PUT of live.json deletes it, so the
//                            page falls back to live.json until the Mac publishes again
//   /p/<slug>/live/r/<hash>.json  one run, content-addressed under "<slug>/live/r/<hash>.json", cached by the browser for good
//   /p/<slug>/answers/x.json JSON documents another scheduled job writes there under "<slug>/answers/x.json"
//   /p/<slug>/api/rows       rows of one family and split from the EXPLORER database (sampled rows; older pages)
//   /p/<slug>/api/search     full-text search over those rows
//   /p/<slug>/api/rows/...   every row of mechanistic_data (neuracles-lab docs/dataset-rows.md): datasets, fams, list, find,
//                            search and row from the ROWS database; a row's compressed block from the ROW_BLOCKS
//                            namespace under "<pack>@<boff>" (one key per block, in place of a byte range of the pack)
//   /p/<slug>/chat/...       the oracle chat behind a password login (oracle-chat.ts), for a slug with a "<slug>/chat" key
// The api answers only for a slug with a "<slug>/explorer" key in PAGES, so no slug is written here.

type Bindings = MetricsBindings & { ASSETS: Fetcher; PAGES?: KVNamespace; EXPLORER?: D1Database; ROWS?: D1Database; ROW_BLOCKS?: KVNamespace; LIVE_WRITE?: string;
	ORACLE_CHAT_URL?: string; ORACLE_CHAT_TOKEN?: string; ORACLE_CHAT_COOKIE_KEY?: string };

const PAGE = /^\/p\/([0-9a-f]{16,64})\/(.*)$/;
const HIDDEN = {
	"X-Robots-Tag": "noindex, nofollow, noarchive, nosnippet",
	"Referrer-Policy": "no-referrer",
	"X-Content-Type-Options": "nosniff",
};
const SPLITS = new Set(["train", "dev", "test"]);
const LIVE_RUN = /^live\/r\/[0-9a-f]{16,64}\.json$/;
const ANSWERS = /^answers\/[a-z0-9_-]{1,160}\.json$/;
const PAGE_ROWS = 25;
const ROWS_LIMIT = 200;
const ROW_SPLITS = new Set(["train", "dev", "test", "kept_back", "graded"]);

function json(body: string, status = 200, cache = "no-store"): Response {
	return new Response(body, { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": cache, ...HIDDEN } });
}

function withHidden(res: Response): Response {
	const out = new Response(res.body, res);
	for (const [k, v] of Object.entries(HIDDEN)) out.headers.set(k, v);
	return out;
}

// Words to an FTS5 query: each word quoted (so no operator can be injected), all of them required.
function ftsQuery(q: string): string | null {
	const words = (q.normalize("NFKC").match(/[\p{L}\p{N}_]+/gu) || []).slice(0, 8);
	return words.length ? words.map((w) => `"${w}"`).join(" ") : null;
}

async function api(rest: string, url: URL, db: D1Database): Promise<Response> {
	if (rest === "api/rows") {
		const fam = Number(url.searchParams.get("fam"));
		const split = url.searchParams.get("split") || "";
		const offset = Math.max(0, Math.min(10_000, Number(url.searchParams.get("offset")) || 0));
		if (!Number.isInteger(fam) || fam < 0 || !SPLITS.has(split)) return json('{"error":"fam and split"}', 400);
		const r = await db.prepare("SELECT body FROM rows WHERE fam = ?1 AND split = ?2 ORDER BY ord LIMIT ?3 OFFSET ?4")
			.bind(fam, split, PAGE_ROWS, offset).all<{ body: string }>();
		return json(`{"rows":[${r.results.map((x) => x.body).join(",")}]}`, 200, "private, max-age=300");
	}
	if (rest === "api/search") {
		const q = ftsQuery(url.searchParams.get("q") || "");
		if (!q) return json('{"rows":[]}');
		const fam = url.searchParams.get("fam");
		const famN = fam === null || fam === "" ? null : Number(fam);
		if (famN !== null && (!Number.isInteger(famN) || famN < 0)) return json('{"error":"fam"}', 400);
		const sql = "SELECT r.fam AS fam, r.body AS body FROM rows_fts f JOIN rows r ON r.rid = f.rowid WHERE rows_fts MATCH ?1"
			+ (famN === null ? "" : " AND r.fam = ?2") + " ORDER BY f.rank LIMIT 40";
		const stmt = famN === null ? db.prepare(sql).bind(q) : db.prepare(sql).bind(q, famN);
		try {
			const r = await stmt.all<{ fam: number; body: string }>();
			return json(`{"rows":[${r.results.map((x) => `{"fam":${x.fam},"row":${x.body}}`).join(",")}]}`, 200, "private, max-age=300");
		} catch {
			return json('{"error":"search failed"}', 400);
		}
	}
	return json('{"error":"not found"}', 404);
}

const intOf = (v: string | null, lo = 0, hi = Number.MAX_SAFE_INTEGER): number | null => {
	if (v === null || v === "" || !/^\d+$/.test(v)) return null;
	const n = Number(v);
	return n >= lo && n <= hi ? n : null;
};

// The row routes of docs/dataset-rows.md, the same answers as viewer/rows_serve.py.
async function rowsApi(rest: string, url: URL, db: D1Database, blocks: KVNamespace): Promise<Response> {
	const p = url.searchParams, cache = "private, max-age=3600";
	if (rest === "api/rows/datasets") {
		const r = await db.prepare("SELECT d.ds, d.name, d.title, d.rows, d.first, d.pack, t.added, t.changed FROM datasets d LEFT JOIN dataset_dates t ON t.ds = d.ds ORDER BY d.ds").all();
		return json(JSON.stringify(r.results), 200, cache);
	}
	if (rest === "api/rows/fams") {
		const r = await db.prepare("SELECT fn, split, rows FROM fams").all();
		return json(JSON.stringify(r.results), 200, cache);
	}
	if (rest === "api/rows/list") {
		const after = intOf(p.get("after")) ?? 0, limit = Math.min(intOf(p.get("limit"), 1) ?? 50, ROWS_LIMIT);
		const cols = "rid, id, ds, fn, split, fam, q, opts, a, meta", fn = intOf(p.get("fn")), ds = intOf(p.get("ds")), split = p.get("split") || "";
		if (split && !ROW_SPLITS.has(split)) return json('{"error":"split"}', 400);
		let stmt: D1PreparedStatement;
		if (fn !== null) stmt = db.prepare(`SELECT ${cols} FROM rows WHERE fn = ?1 AND split = ?2 AND rid > ?3 ORDER BY rid LIMIT ?4`).bind(fn, split, after, limit);
		else if (ds !== null && split) stmt = db.prepare(`SELECT ${cols} FROM rows WHERE ds = ?1 AND split = ?2 AND rid > ?3 ORDER BY rid LIMIT ?4`).bind(ds, split, after, limit);
		else if (ds !== null) {
			// a dataset's rows are consecutive from its first rid (datasets.first; a dataset reloaded alone gets new rids after
			// every other row): start the rid scan there, so nothing scans or sorts a big dataset (MIN(rid) or ORDER BY rid over
			// rows_ds read the whole dataset and overloaded D1). Without first, datasets take consecutive rids in ds order.
			const lo = await db.prepare("SELECT COALESCE((SELECT first - 1 FROM datasets WHERE ds = ?1), (SELECT COALESCE(SUM(rows), 0) FROM datasets WHERE ds < ?1)) AS m").bind(ds).first<{ m: number }>();
			stmt = db.prepare(`SELECT ${cols} FROM rows WHERE rid > ?1 AND ds = ?2 ORDER BY rid LIMIT ?3`).bind(Math.max(after, lo ? lo.m : 0), ds, limit);
		}
		else return json('{"error":"give fn and split, or ds"}', 400);
		const r = await stmt.all();
		return json(JSON.stringify({ rows: r.results }), 200, cache);
	}
	if (rest === "api/rows/search") {
		const words = ((p.get("q") || "").normalize("NFKC").match(/[\p{L}\p{N}]+/gu) || []).slice(0, 8);
		if (!words.length) return json('{"rows":[]}');
		const limit = Math.min(intOf(p.get("limit"), 1) ?? 50, ROWS_LIMIT), ds = intOf(p.get("ds"));
		const match = words.map((w) => `"${w}"`).join(" ");
		const sql = "SELECT r.rid, r.id, r.ds, r.fn, r.split, r.q, r.a FROM rows_fts f JOIN rows r ON r.rid = f.rowid WHERE rows_fts MATCH ?1"
			+ (ds === null ? " LIMIT ?2" : " AND r.ds = ?2 LIMIT ?3");
		try {
			const r = await (ds === null ? db.prepare(sql).bind(match, limit) : db.prepare(sql).bind(match, ds, limit)).all();
			return json(JSON.stringify({ rows: r.results }), 200, "private, max-age=300");
		} catch {
			return json('{"error":"search failed"}', 400);
		}
	}
	if (rest === "api/rows/find") {
		const id = (p.get("id") || "").slice(0, 300), dataset = p.get("dataset") || "";
		if (!id) return json('{"error":"give id"}', 400);
		const stmt = dataset
			? db.prepare("SELECT r.rid, r.ds, r.fn, r.split, r.id FROM rows r JOIN datasets d ON d.ds = r.ds WHERE r.id = ?1 AND d.name = ?2 ORDER BY r.rid LIMIT 20").bind(id, dataset)
			: db.prepare("SELECT r.rid, r.ds, r.fn, r.split, r.id FROM rows r WHERE r.id = ?1 ORDER BY r.rid LIMIT 20").bind(id);
		const r = await stmt.all();
		return json(JSON.stringify({ rows: r.results }), 200, cache);
	}
	if (rest === "api/rows/row") {
		const rid = intOf(p.get("rid"), 1);
		if (rid === null) return json('{"error":"rid"}', 400);
		const hit = await db.prepare("SELECT d.pack AS pack, r.boff AS boff, r.roff AS roff, r.rlen AS rlen FROM rows r JOIN datasets d ON d.ds = r.ds WHERE r.rid = ?1")
			.bind(rid).first<{ pack: string; boff: number; roff: number; rlen: number }>();
		if (!hit) return json('{"error":"no such row"}', 404);
		const block = await blocks.get(`${hit.pack}@${hit.boff}`, "arrayBuffer");
		if (block === null) return json('{"error":"row block missing"}', 502);
		const raw = await new Response(new Blob([block]).stream().pipeThrough(new DecompressionStream("deflate"))).arrayBuffer();
		return new Response(raw.slice(hit.roff, hit.roff + hit.rlen), { status: 200, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": cache, ...HIDDEN } });
	}
	return json('{"error":"no such route"}', 404);
}

// A pod's copy of live.json: only with the write secret, only for a slug that already has one, valid JSON under 20 MB.
async function putLive(request: Request, env: Bindings, slug: string): Promise<Response> {
	const want = env.LIVE_WRITE ? new TextEncoder().encode(`Bearer ${env.LIVE_WRITE}`) : null;
	const got = new TextEncoder().encode(request.headers.get("Authorization") || "");
	if (!want || !env.PAGES || got.byteLength !== want.byteLength || !crypto.subtle.timingSafeEqual(got, want)) {
		return json('{"error":"forbidden"}', 403);
	}
	if ((await env.PAGES.get(`${slug}/live.json`)) === null) return json('{"error":"not found"}', 404);
	const body = await request.text();
	if (body.length > 20_000_000) return json('{"error":"too large"}', 413);
	try {
		JSON.parse(body);
	} catch {
		return json('{"error":"not json"}', 400);
	}
	await env.PAGES.put(`${slug}/live.json`, body);
	await env.PAGES.delete(`${slug}/live/index.json`);
	return json('{"ok":true}');
}

export async function hiddenPage(request: Request, env: Bindings): Promise<Response | null> {
	const url = new URL(request.url);
	const m = PAGE.exec(url.pathname);
	if (!m) return url.pathname.startsWith("/p/") ? withHidden(await env.ASSETS.fetch(request)) : null;
	const [, slug, rest] = m;
	const metrics = await liveMetrics(request, env, slug, rest);
	if (metrics) return metrics;
	if (request.method === "PUT" && rest === "live.json") return putLive(request, env, slug);
	const chat = await oracleChat(request, env, slug, rest);
	if (chat) return chat;
	if (request.method !== "GET" && request.method !== "HEAD") return new Response("method not allowed", { status: 405, headers: HIDDEN });
	if (rest === "live.json" && env.PAGES) {
		const v = await env.PAGES.get(`${slug}/live.json`);
		if (v !== null) return json(v);
	}
	if (rest === "live/index.json" && env.PAGES) {
		const v = await env.PAGES.get(`${slug}/live/index.json`);
		if (v === null) return json('{"error":"not found"}', 404);
		const hash = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(v));
		const etag = `"${[...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("")}"`;
		const headers = { ETag: etag, "Cache-Control": "no-cache", ...HIDDEN };
		if ((request.headers.get("If-None-Match") || "").split(/\s*,\s*/).some((t) => t.replace(/^W\//, "") === etag)) return new Response(null, { status: 304, headers });
		return new Response(v, { headers: { "Content-Type": "application/json; charset=utf-8", ...headers } });
	}
	if (LIVE_RUN.test(rest) && env.PAGES) {
		const v = await env.PAGES.get(`${slug}/${rest}`);
		return v === null ? json('{"error":"not found"}', 404) : json(v, 200, "private, max-age=31536000, immutable");
	}
	if (ANSWERS.test(rest) && env.PAGES) {
		const v = await env.PAGES.get(`${slug}/${rest}`);
		return v === null ? json('{"error":"not found"}', 404) : json(v, 200, rest === "answers/index.json" ? "no-store" : "private, max-age=120");
	}
	if (rest.startsWith("api/rows/")) {
		if (!env.PAGES || !env.ROWS || !env.ROW_BLOCKS || (await env.PAGES.get(`${slug}/explorer`)) === null) return json('{"error":"not found"}', 404);
		return rowsApi(rest, url, env.ROWS, env.ROW_BLOCKS);
	}
	if (rest.startsWith("api/")) {
		if (!env.PAGES || !env.EXPLORER || (await env.PAGES.get(`${slug}/explorer`)) === null) return json('{"error":"not found"}', 404);
		return api(rest, url, env.EXPLORER);
	}
	return withHidden(await env.ASSETS.fetch(request));
}
