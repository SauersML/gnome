import { DurableObject } from "cloudflare:workers";

// One object per hidden dashboard. Updates to different runs share the page cursor,
// while credentials authorize exactly one (page, run) pair.
export type MetricUpdate = {
	version: 1; seq: number; step: number; time: string;
	arm: "all" | "ao" | "text";
	state: "running" | "finished" | "failed" | "paused";
	metrics: Record<string, number>;
};
type RunRecord = { run_id: string; seq: number; step: number; time: string; arm: string; state: string; metrics: string; received_at: string };
type EventRecord = { revision: number; run_id: string; body: string; received_at: string };
export type MetricsBindings = {
	LIVE_METRICS?: DurableObjectNamespace<LiveMetrics>;
	LIVE_METRICS_SECRET?: string;
	PAGES?: KVNamespace;
};
const RUN_ID = /^[a-zA-Z0-9_-]{1,64}$/;
const MAX_BODY = 16_384;
const MAX_KEYS = 128;
const METRIC_KEY = /^(?:train|dev|dev_how|time|system|opt|diagnostics|comparison|gold_logp)\/[A-Za-z0-9_./-]{1,120}$/;
const HIDDEN = { "X-Robots-Tag": "noindex, nofollow, noarchive, nosnippet", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" };
const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: { ...HIDDEN, "Cache-Control": "no-store" } });

function updateOf(value: unknown): MetricUpdate | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const v = value as Record<string, unknown>;
	if (Object.keys(v).some(k => !["version", "seq", "step", "time", "arm", "state", "metrics"].includes(k)) || v.version !== 1 ||
		!Number.isSafeInteger(v.seq) || Number(v.seq) < 1 || !Number.isSafeInteger(v.step) || Number(v.step) < 0 ||
		typeof v.time !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(v.time) || !Number.isFinite(Date.parse(v.time)) ||
		!["all", "ao", "text"].includes(String(v.arm)) || !["running", "finished", "failed", "paused"].includes(String(v.state)) ||
		!v.metrics || typeof v.metrics !== "object" || Array.isArray(v.metrics)) return null;
	const entries = Object.entries(v.metrics).sort(([a], [b]) => a.localeCompare(b));
	if (!entries.length || entries.length > MAX_KEYS || entries.some(([k, n]) => !METRIC_KEY.test(k) || k.split("/").includes("own_minus_twin") || typeof n !== "number" || !Number.isFinite(n))) return null;
	return { version: 1, seq: Number(v.seq), step: Number(v.step), time: new Date(v.time).toISOString(),
		arm: v.arm as MetricUpdate["arm"], state: v.state as MetricUpdate["state"], metrics: Object.fromEntries(entries) };
}

async function authorized(request: Request, secret: string | undefined, slug: string, run: string): Promise<boolean> {
	const token = /^Bearer ([0-9a-f]{64})$/.exec(request.headers.get("Authorization") || "");
	if (!secret || !token) return false;
	const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
	const signature = Uint8Array.from(token[1].match(/../g)!, n => parseInt(n, 16));
	return crypto.subtle.verify("HMAC", key, signature, new TextEncoder().encode(`moracles-live-v1\n${slug}\n${run}`));
}

async function smallBody(request: Request): Promise<string | null> {
	if (!request.body) return "";
	const reader = request.body.getReader(), chunks: Uint8Array[] = [];
	let length = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		length += value.byteLength;
		if (length > MAX_BODY) { await reader.cancel(); return null; }
		chunks.push(value);
	}
	const bytes = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
	return new TextDecoder().decode(bytes);
}

export async function liveMetrics(request: Request, env: MetricsBindings, slug: string, rest: string): Promise<Response | null> {
	if (rest !== "metrics.json" && !rest.startsWith("metrics/")) return null;
	if (!env.LIVE_METRICS) return reply({ error: "metrics unavailable" }, 503);
	const url = new URL(request.url);
	if (rest.startsWith("metrics/")) {
		if (request.method !== "POST") return reply({ error: "method not allowed" }, 405);
		const run = rest.slice("metrics/".length);
		if (!RUN_ID.test(run)) return reply({ error: "invalid run" }, 400);
		if (!await authorized(request, env.LIVE_METRICS_SECRET, slug, run)) return reply({ error: "forbidden" }, 403);
		// Keep the same existing-page admission boundary as the legacy live.json writer.
		if (!env.PAGES || await env.PAGES.get(`${slug}/live.json`) === null) return reply({ error: "not found" }, 404);
		if (request.headers.get("Content-Type")?.split(";")[0].trim() !== "application/json") return reply({ error: "expected application/json" }, 415);
		const body = await smallBody(request);
		if (body === null) return reply({ error: "too large" }, 413);
		let update: MetricUpdate | null;
		try { update = updateOf(JSON.parse(body)); } catch { update = null; }
		if (!update) return reply({ error: "invalid metric update" }, 400);
		const result = await env.LIVE_METRICS.getByName(slug).append(run, update);
		return reply(result.body, result.status);
	}
	if (request.method !== "GET") return reply({ error: "method not allowed" }, 405);
	const raw = url.searchParams.get("after");
	if (raw !== null && (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)))) return reply({ error: "invalid cursor" }, 400);
	if (!env.PAGES || await env.PAGES.get(`${slug}/live.json`) === null) return reply({ error: "not found" }, 404);
	return reply(await env.LIVE_METRICS.getByName(slug).read(raw === null ? null : Number(raw)));
}

export class LiveMetrics extends DurableObject<MetricsBindings> {
	constructor(ctx: DurableObjectState, env: MetricsBindings) {
		super(ctx, env);
		ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS runs (run_id TEXT PRIMARY KEY, seq INTEGER NOT NULL,
			step INTEGER NOT NULL, time TEXT NOT NULL, arm TEXT NOT NULL, state TEXT NOT NULL, metrics TEXT NOT NULL, received_at TEXT NOT NULL)`);
		ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS events (revision INTEGER PRIMARY KEY AUTOINCREMENT,
			run_id TEXT NOT NULL, seq INTEGER NOT NULL, body TEXT NOT NULL, received_at TEXT NOT NULL, UNIQUE(run_id, seq))`);
	}

	append(run: string, update: MetricUpdate) {
		return this.ctx.storage.transactionSync(() => {
			const sql = this.ctx.storage.sql, body = JSON.stringify(update);
			const previous = sql.exec<EventRecord>("SELECT revision, body FROM events WHERE run_id = ? AND seq = ?", run, update.seq).toArray()[0];
			if (previous) return previous.body === body
				? { status: 200, body: { ok: true, duplicate: true, cursor: previous.revision, seq: update.seq } }
				: { status: 409, body: { error: "sequence already contains different data" } };
			const latest = sql.exec<RunRecord>("SELECT * FROM runs WHERE run_id = ?", run).toArray()[0];
			if (update.seq !== (latest?.seq || 0) + 1) return { status: 409, body: { error: "sequence out of order", expected_seq: (latest?.seq || 0) + 1 } };
			if (latest && (update.step < latest.step || update.arm !== latest.arm)) return { status: 409, body: { error: "run identity or step regression" } };
			const received_at = new Date().toISOString();
			const metrics = { ...(latest ? JSON.parse(latest.metrics) : {}), ...update.metrics };
			if (Object.keys(metrics).length > 2048) return { status: 400, body: { error: "too many distinct metrics" } };
			const revision = sql.exec<{ revision: number }>("INSERT INTO events (run_id, seq, body, received_at) VALUES (?, ?, ?, ?) RETURNING revision", run, update.seq, body, received_at).one().revision;
			sql.exec("INSERT OR REPLACE INTO runs VALUES (?, ?, ?, ?, ?, ?, ?, ?)", run, update.seq, update.step, update.time, update.arm, update.state, JSON.stringify(metrics), received_at);
			return { status: 200, body: { ok: true, duplicate: false, cursor: revision, seq: update.seq } };
		});
	}

	read(after: number | null) {
		const sql = this.ctx.storage.sql;
		const cursor = sql.exec<{ cursor: number }>("SELECT COALESCE(MAX(revision), 0) AS cursor FROM events").one().cursor;
		if (after === null) return { version: 1, cursor, snapshot: true,
			runs: sql.exec<RunRecord>("SELECT * FROM runs ORDER BY run_id").toArray().map(r => ({ ...r, metrics: JSON.parse(r.metrics) })), events: [], has_more: false };
		if (after > cursor) return { version: 1, cursor, reset: true, events: [], has_more: false };
		const rows = sql.exec<EventRecord>("SELECT revision, run_id, body, received_at FROM events WHERE revision > ? ORDER BY revision LIMIT 32", after).toArray();
		const next = rows.at(-1)?.revision ?? after;
		return { version: 1, cursor: next, snapshot: false,
			events: rows.map(r => ({ revision: r.revision, run_id: r.run_id, received_at: r.received_at, ...JSON.parse(r.body) })), has_more: next < cursor };
	}
}
