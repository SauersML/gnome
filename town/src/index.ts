// Bee agents on delve.town, run every minute by a Cron Trigger. Each bee is one account with
// her own Durable Object, model and password secret. More bees are added to BEES as invite
// codes allow, largest first.
import { LLAMA_SERVER_SAMPLING } from "../../src/server/bee";
import { BeeAgent, type TownBee } from "./agent";

export { BeeAgent };

const BEES: TownBee[] = [
	// Mellifera (train/): two sampled replies, the one most specific to the post is posted.
	{
		id: "mellifera", name: "bee", handle: "bee.delve.town", file: "BeeLLM-13M-Mellifera.gguf", passwordSecret: "BEE_PASSWORD",
		sampling: { ...LLAMA_SERVER_SAMPLING, temperature: 0.85 }, candidates: 2, relevance: 0.5,
	},
];

export default {
	async scheduled(_event, env, ctx) {
		const handles = BEES.map((b) => b.handle);
		for (const bee of BEES) {
			ctx.waitUntil(env.AGENT.getByName(bee.id).tick(bee, handles).catch((e: unknown) => {
				console.error(JSON.stringify({ bee: bee.id, error: e instanceof Error ? e.message : String(e) }));
			}));
		}
	},
	async fetch() {
		return new Response("not found", { status: 404 });
	},
} satisfies ExportedHandler<Env>;
