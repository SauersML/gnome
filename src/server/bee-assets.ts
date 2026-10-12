import { BeeModel, LLAMA_SERVER_SAMPLING, type Sampling } from "./bee";

type Manifest = { bytes: number; parts: string[]; sha256: string };

const assetUrl = (path: string) => new Request(new URL(`/bee/${path}`, "https://assets.local"));

// The sha256 of the GGUF a manifest describes, which names the model's version.
export async function beeVersion(assets: Fetcher, file: string): Promise<string> {
	const res = await assets.fetch(assetUrl(`${file}.json`));
	if (!res.ok) throw new Error(`${file} manifest HTTP ${res.status}`);
	return (await res.json() as Manifest).sha256;
}

// Loads a BeeLLM GGUF written by scripts/fetch-bee.mjs from static assets.
// ctx is the number of positions to keep in the KV cache (prompt plus reply).
export async function loadBee(assets: Fetcher, file: string, ctx?: number, sampling: Sampling = LLAMA_SERVER_SAMPLING): Promise<BeeModel> {
	const get = (path: string) => assets.fetch(assetUrl(path));
	const res = await get(`${file}.json`);
	if (!res.ok) throw new Error(`${file} manifest HTTP ${res.status}`);
	const manifest = await res.json() as Manifest;
	const bytes = new Uint8Array(manifest.bytes);
	let offset = 0;
	for (const part of manifest.parts) {
		const partRes = await get(part);
		if (!partRes.ok || !partRes.body) throw new Error(`${part} HTTP ${partRes.status}`);
		const reader = partRes.body.getReader();
		for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
			if (offset + chunk.value.length > bytes.length) throw new Error(`${file} is larger than its manifest says`);
			bytes.set(chunk.value, offset);
			offset += chunk.value.length;
		}
	}
	if (offset !== manifest.bytes) throw new Error(`${file} is ${offset} bytes, expected ${manifest.bytes}`);
	return new BeeModel(bytes.buffer, ctx, sampling);
}
