// bee.gnome.science: the swarm page (static assets) and POST /api/buzz, which runs one
// bee on the conversation so far. The page decides who buzzes next and when to stop.
import type { BeeModel } from "../../src/server/bee";
import { loadBee } from "../../src/server/bee-assets";
import { SWARM, parseBuzz, speak } from "./swarm";

interface Env {
	ASSETS: Fetcher;
	BUZZ_LIMIT: RateLimit;
}

const MAX_BODY = 64 * 1024;
const models = new Map<string, Promise<BeeModel>>();

function model(env: Env, file: string): Promise<BeeModel> {
	let m = models.get(file);
	if (!m) {
		m = loadBee(env.ASSETS, file);
		models.set(file, m);
		m.catch(() => models.delete(file));
	}
	return m;
}

const error = (status: number, message: string) => Response.json({ error: message }, { status });

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname !== "/api/buzz") return env.ASSETS.fetch(request);
		if (request.method !== "POST") return error(405, "POST only");
		const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
		if (!(await env.BUZZ_LIMIT.limit({ key: ip })).success) return error(429, "the hive needs a rest, try again in a minute");
		const raw = await request.text();
		if (raw.length > MAX_BODY) return error(413, "too long");
		let body: unknown;
		try { body = JSON.parse(raw); } catch { return error(400, "expected JSON"); }
		const parsed = parseBuzz(body);
		if ("error" in parsed) return error(400, parsed.error);
		try {
			const text = speak(parsed.bee, await model(env, parsed.bee.file), parsed.transcript);
			return Response.json({ bee: parsed.bee.id, text });
		} catch (e) {
			console.error(parsed.bee.id, "failed:", e instanceof Error ? e.message : String(e));
			return error(500, "this bee couldn't buzz right now");
		}
	},
} satisfies ExportedHandler<Env>;

