// Hidden pages under /p/<slug>/: static files from public/p/<slug>/ (git-ignored), sent with headers that keep them out of
// search engines, plus dynamic parts that live outside git:
//   /p/<slug>/live.json      a JSON document a scheduled job writes to the PAGES namespace under "<slug>/live.json"
//                            (by wrangler from the Mac, or by PUT with "Authorization: Bearer <LIVE_WRITE>" from a pod,
//                            so the page stays live with the Mac offline; the secret can write this one key and nothing else)
//   /p/<slug>/answers/x.json JSON documents another scheduled job writes there under "<slug>/answers/x.json"
//   /p/<slug>/api/rows       rows of one family and split from the EXPLORER database
//   /p/<slug>/api/search     full-text search over those rows
// The api answers only for a slug with a "<slug>/explorer" key in PAGES, so no slug is written here.

type Bindings = { ASSETS: Fetcher; PAGES?: KVNamespace; EXPLORER?: D1Database; LIVE_WRITE?: string };

const PAGE = /^\/p\/([0-9a-f]{16,64})\/(.*)$/;
const HIDDEN = {
	"X-Robots-Tag": "noindex, nofollow, noarchive, nosnippet",
	"Referrer-Policy": "no-referrer",
	"X-Content-Type-Options": "nosniff",
};
const SPLITS = new Set(["train", "dev", "test"]);
const ANSWERS = /^answers\/[a-z0-9_-]{1,160}\.json$/;
const PAGE_ROWS = 25;

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
	return json('{"ok":true}');
}

export async function hiddenPage(request: Request, env: Bindings): Promise<Response | null> {
	const url = new URL(request.url);
	const m = PAGE.exec(url.pathname);
	if (!m) return url.pathname.startsWith("/p/") ? withHidden(await env.ASSETS.fetch(request)) : null;
	const [, slug, rest] = m;
	if (request.method === "PUT" && rest === "live.json") return putLive(request, env, slug);
	if (request.method !== "GET" && request.method !== "HEAD") return new Response("method not allowed", { status: 405, headers: HIDDEN });
	if (rest === "live.json" && env.PAGES) {
		const v = await env.PAGES.get(`${slug}/live.json`);
		if (v !== null) return json(v);
	}
	if (ANSWERS.test(rest) && env.PAGES) {
		const v = await env.PAGES.get(`${slug}/${rest}`);
		return v === null ? json('{"error":"not found"}', 404) : json(v, 200, rest === "answers/index.json" ? "no-store" : "private, max-age=120");
	}
	if (rest.startsWith("api/")) {
		if (!env.PAGES || !env.EXPLORER || (await env.PAGES.get(`${slug}/explorer`)) === null) return json('{"error":"not found"}', 404);
		return api(rest, url, env.EXPLORER);
	}
	return withHidden(await env.ASSETS.fetch(request));
}
