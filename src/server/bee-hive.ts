import { DurableObject } from "cloudflare:workers";
import { type BeeModel, type BeeTurn, LLAMA_SERVER_SAMPLING, MAX_PROMPT_TOKENS } from "./bee";
import { loadBee } from "./bee-assets";
import { garblePenalty } from "./garble.ts";

// Holds the Somnia weights (served as static assets by scripts/fetch-bee.mjs) in its own
// object, so generating a reply never blocks the chat room. She samples six replies and posts
// the one most specific to what was said, made of whole words.
export class BeeHive extends DurableObject<Env> {
	private model: Promise<BeeModel> | null = null;

	private load(): Promise<BeeModel> {
		this.model ??= loadBee(this.env.ASSETS, "BeeLLM-13M-Somnia-Q8_0.gguf", undefined, { ...LLAMA_SERVER_SAMPLING, temperature: 0.85, firstTemperature: 0.3, loopLimit: 6 });
		this.model.catch(() => { this.model = null; });
		return this.model;
	}

	async reply(turns: BeeTurn[]): Promise<string> {
		return (await this.load()).reply(turns, Math.random, MAX_PROMPT_TOKENS, 6, 0.5, garblePenalty(turns.at(-1)?.content ?? ""));
	}
}
