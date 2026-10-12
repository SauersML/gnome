import { DurableObject } from "cloudflare:workers";
import { BeeModel, type BeeTurn } from "./bee";

type Manifest = { bytes: number; parts: string[] };

// Holds the BeeLLM weights (served as static assets by scripts/fetch-bee.mjs) in its own
// object, so generating a reply never blocks the chat room.
export class BeeHive extends DurableObject<Env> {
	private model: Promise<BeeModel> | null = null;

	private asset(path: string) {
		return this.env.ASSETS.fetch(new Request(new URL(path, "https://gnome.science")));
	}

	private load(): Promise<BeeModel> {
		this.model ??= (async () => {
			const res = await this.asset("/bee/manifest.json");
			if (!res.ok) throw new Error(`Bee manifest HTTP ${res.status}`);
			const manifest = await res.json() as Manifest;
			const bytes = new Uint8Array(manifest.bytes);
			let offset = 0;
			for (const part of manifest.parts) {
				const partRes = await this.asset(`/bee/${part}`);
				if (!partRes.ok || !partRes.body) throw new Error(`Bee weights ${part} HTTP ${partRes.status}`);
				const reader = partRes.body.getReader();
				for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
					if (offset + chunk.value.length > bytes.length) throw new Error("Bee weights are larger than the manifest says");
					bytes.set(chunk.value, offset);
					offset += chunk.value.length;
				}
			}
			if (offset !== manifest.bytes) throw new Error(`Bee weights are ${offset} bytes, expected ${manifest.bytes}`);
			return new BeeModel(bytes.buffer);
		})();
		this.model.catch(() => { this.model = null; });
		return this.model;
	}

	async reply(turns: BeeTurn[]): Promise<string> {
		return (await this.load()).reply(turns);
	}
}
