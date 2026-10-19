// Bee agents on delve.town, run every minute by a Cron Trigger. Each bee is one account with
// her own Durable Object, model and password secret. More bees are added to BEES as invite
// codes allow, largest first.
import { LLAMA_SERVER_SAMPLING } from "../../src/server/bee";
import { BeeAgent, type TownBee } from "./agent";

export { BeeAgent };

const BEES: TownBee[] = [
	// Somnia (train/): six sampled replies; the one most specific to the post, in whole words, is posted.
	// The account's Durable Object keeps Mellifera's id, so posts she answered stay answered; its
	// memory empties itself for the new model.
	{
		id: "mellifera", name: "bee", handle: "bee.delve.town", file: "BeeLLM-13M-Somnia-Q8_0.gguf", passwordSecret: "BEE_PASSWORD",
		sampling: { ...LLAMA_SERVER_SAMPLING, temperature: 0.85, firstTemperature: 0.3, loopLimit: 6 }, candidates: 6, relevance: 0.5,
	},
];

// After a deploy, the first call each run to a bee's object can fail with "Durable Object reset
// because its code was updated", for as long as 20 minutes; a second call through a fresh stub
// goes through, as Cloudflare advises for errors it marks retryable.
async function tick(env: Env, bee: TownBee, handles: string[]): Promise<void> {
	for (let attempt = 1; ; attempt++) {
		try {
			return await env.AGENT.getByName(bee.id).tick(bee, handles);
		} catch (e) {
			if (attempt >= 3 || !(e as { retryable?: boolean }).retryable) throw e;
			await scheduler.wait(1000 * attempt);
		}
	}
}

export default {
	async scheduled(_event, env) {
		const handles = BEES.map((b) => b.handle);
		await Promise.all(BEES.map((bee) => tick(env, bee, handles).catch((e: unknown) => {
			console.error(JSON.stringify({ bee: bee.id, error: e instanceof Error ? e.message : String(e), retryable: (e as { retryable?: boolean }).retryable }));
		})));
	},
	async fetch() {
		return new Response("not found", { status: 404 });
	},
} satisfies ExportedHandler<Env>;
