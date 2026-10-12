import { DurableObject } from "cloudflare:workers";
import type { BeeModel, BeeTurn } from "./bee";
import { loadBee } from "./bee-assets";

// Holds the BeeLLM 12M Mood weights (served as static assets by scripts/fetch-bee.mjs) in
// its own object, so generating a reply never blocks the chat room.
export class BeeHive extends DurableObject<Env> {
	private model: Promise<BeeModel> | null = null;

	private load(): Promise<BeeModel> {
		this.model ??= loadBee(this.env.ASSETS, "BeeLLM-12M-Mood.gguf");
		this.model.catch(() => { this.model = null; });
		return this.model;
	}

	async reply(turns: BeeTurn[]): Promise<string> {
		return (await this.load()).reply(turns);
	}
}
