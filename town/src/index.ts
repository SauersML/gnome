// Bee agents on delve.town, run every minute by a Cron Trigger. Each bee is one account with
// her own Durable Object, model and password secret. More bees are added to BEES as invite
// codes allow, largest first.
import { BeeAgent, type TownBee } from "./agent";

export { BeeAgent };

const BEES: TownBee[] = [
	{ id: "scintilla", name: "bee", handle: "bee.delve.town", file: "BeeLLM-12M-Mood.gguf", passwordSecret: "SCINTILLA_PASSWORD" },
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
