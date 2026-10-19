// bee.gnome.science: the swarm page (static assets) and POST /api/buzz, which runs one
// bee on the conversation so far. The page decides who buzzes next and when to stop.
import { DurableObject } from "cloudflare:workers";
import { type BeeModel, LLAMA_SERVER_SAMPLING } from "../../src/server/bee";
import { loadBee } from "../../src/server/bee-assets";
import { SWARM, type SwarmEntry, parseBuzz, rateKey, speak } from "./swarm";

interface Env {
	ASSETS: Fetcher;
	BUZZ_LIMIT: RateLimit;
	HIVE: DurableObjectNamespace<BeeCell>;
}

const MAX_BODY = 64 * 1024;
// A buzz that waited this long behind others is turned away unrun. Somnia takes up to about 40 s.
const MAX_WAIT_MS = 60_000;
// Paths only llama.cpp's web UI requests. That UI was served here briefly and its service
// worker can keep showing it; answering its requests this way makes the browser drop it.
const OLD_UI = /^\/(?:props|models(?:\/.*)?|v1\/models|health|v1\/health|build\.json|tools|slots|cors-proxy|v1\/chat\/completions(?:\/.*)?|v1\/streams?(?:\/.*)?|manifest\.webmanifest|_app\/.*)$/;

// Each bee runs in her own Durable Objects (one, or `cells`), one buzz at a time each, so however
// many requests arrive, at most nine buzzes are computed at once and the swarm's cost has a
// fixed ceiling.
export class BeeCell extends DurableObject<Env> {
	private model: Promise<BeeModel> | null = null;

	async buzz(beeId: string, transcript: SwarmEntry[], sentAt: number): Promise<string | null> {
		if (Date.now() - sentAt > MAX_WAIT_MS) return null;
		const bee = SWARM.find((b) => b.id === beeId);
		if (!bee) throw new Error(`unknown bee ${beeId}`);
		this.model ??= loadBee(this.env.ASSETS, bee.file, undefined, { ...LLAMA_SERVER_SAMPLING, ...bee.sampling });
		this.model.catch(() => { this.model = null; });
		return speak(bee, await this.model, transcript);
	}
}

const error = (status: number, message: string) => Response.json({ error: message }, { status });

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		if (OLD_UI.test(url.pathname)) return new Response(null, { status: 410, headers: { "Clear-Site-Data": '"cache", "storage"' } });
		if (url.pathname !== "/api/buzz") return env.ASSETS.fetch(request);
		if (request.method !== "POST") return error(405, "POST only");
		const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
		if (!(await env.BUZZ_LIMIT.limit({ key: rateKey(ip) })).success) return error(429, "the hive needs a rest, try again in a minute");
		// The page always sends Content-Length; a body without one, or longer, is never read.
		if (!(Number(request.headers.get("content-length") ?? Infinity) <= MAX_BODY)) return error(413, "too long");
		const raw = await request.text();
		if (raw.length > MAX_BODY) return error(413, "too long");
		let body: unknown;
		try { body = JSON.parse(raw); } catch { return error(400, "expected JSON"); }
		const parsed = parseBuzz(body);
		if ("error" in parsed) return error(400, parsed.error);
		try {
			const cell = env.HIVE.getByName(`${parsed.bee.id}-${Math.floor(Math.random() * (parsed.bee.cells ?? 1))}`);
			const text = await cell.buzz(parsed.bee.id, parsed.transcript, Date.now());
			if (text === null) return error(503, "the hive is busy, try again in a minute");
			return Response.json({ bee: parsed.bee.id, text });
		} catch (e) {
			console.error(parsed.bee.id, "failed:", e instanceof Error ? e.message : String(e));
			return error(500, "this bee couldn't buzz right now");
		}
	},
} satisfies ExportedHandler<Env>;
