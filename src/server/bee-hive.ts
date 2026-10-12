import { DurableObject } from "cloudflare:workers";
import { type BeeModel, type BeeTurn, LLAMA_SERVER_SAMPLING, MAX_PROMPT_TOKENS } from "./bee";
import { loadBee } from "./bee-assets";

// Holds the post-trained Scintilla weights (served as static assets by scripts/fetch-bee.mjs)
// in its own object, so generating a reply never blocks the chat room. She samples four
// replies and keeps the one most specific to what was said.
export class BeeHive extends DurableObject<Env> {
	private model: Promise<BeeModel> | null = null;

	private load(): Promise<BeeModel> {
		this.model ??= loadBee(this.env.ASSETS, "BeeLLM-12M-Scintilla.gguf", undefined, { ...LLAMA_SERVER_SAMPLING, repeatPenalty: 1.1 });
		this.model.catch(() => { this.model = null; });
		return this.model;
	}

	async reply(turns: BeeTurn[]): Promise<string> {
		return (await this.load()).reply(turns, Math.random, MAX_PROMPT_TOKENS, 4, 0.5);
	}
}
