// Downloads pinned BeeLLM weights, verifies them, and writes each model to <dir>/bee/ as
// parts below the 25 MiB static-asset limit plus <file>.json describing the parts.
// Usage: node scripts/fetch-bee.mjs <public dir, relative to the repo root> <model>...
// Models already present with the pinned hash are skipped. Post-trained models (train/) are
// not published; they are read from ~/BeeLLM/models on the machine that deploys.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

const REVISION = "62fc7082eebc184cc5177a67107318196aee69f7";
const PINS = {
	"BeeLLM-12M-Mood": { bytes: 47913376, sha256: "32d5e894913620beab6b7eda374598a538285217b893ce5f3c7c21d1ef98879b" },
	"BeeLLM-1M-Mood": { bytes: 4486784, sha256: "14fec85f15fdfcd1a2f139f97a8eb7c65d2728985993b8dc4716235da492de52" },
	"BeeLLM-1M-Mood-Chaos": { bytes: 4486848, sha256: "d335a9010bfd1a3de193e5c349844a5af364f7906b439d79f414d0ebef7888f6" },
	"BeeLLM-42P-Chaos": { bytes: 102784, sha256: "6176e9caecf0744be9854f5c6b94d2542a02a750384367fcc293ac443ce4726d" },
	"BeeLLM-42P": { bytes: 50080, sha256: "3bf2fb647a11c54cdb53588eee581acbd9f3aa083d2f921918d812fc602168c1" },
	"BeeLLM-30P": { bytes: 49504, sha256: "e5987a9ac3f66281bf60d886f280db1e5adc04bd8a89468232f6692a16e70bf8" },
	// Mellifera: post-trained from BeeLLM-12M-Mood by train/ (vocabulary grown to 4,096 tokens).
	"BeeLLM-13M-Mellifera": { bytes: 54519872, sha256: "a3e449bda8f79c69cfcfffd9e2fd4420211892e0bf07121a581ca1720a62027d", local: true },
	// Mellifera in Q8_0 (train/quantize.py), for the engine's Q8_0 test.
	"BeeLLM-13M-Mellifera-Q8_0": { bytes: 14573632, sha256: "15f2b898fa95fd8ff17fee93f63b77782bdbe7a17442b1156f7bcff996f5abc4", local: true },
};
const PART_BYTES = 24 * 1024 * 1024;

const [dir, ...models] = process.argv.slice(2);
if (!dir || models.length === 0 || models.some((m) => !PINS[m])) {
	throw new Error(`usage: fetch-bee.mjs <dir> <${Object.keys(PINS).join("|")}>...`);
}
const out = new URL(`../${dir}/bee/`, import.meta.url);
mkdirSync(out, { recursive: true });

for (const model of models) {
	const { bytes, sha256 } = PINS[model];
	const file = `${model}.gguf`;
	const manifestPath = new URL(`${file}.json`, out);
	if (existsSync(manifestPath) && JSON.parse(readFileSync(manifestPath, "utf8")).sha256 === sha256) continue;
	let data;
	if (PINS[model].local) {
		data = readFileSync(`${homedir()}/BeeLLM/models/${file}`);
	} else {
		const url = `https://huggingface.co/schizophyllume/BeeLLM/resolve/${REVISION}/${file}`;
		const res = await fetch(url);
		if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
		data = Buffer.from(await res.arrayBuffer());
	}
	const got = createHash("sha256").update(data).digest("hex");
	if (data.length !== bytes || got !== sha256) throw new Error(`${file}: got ${data.length} bytes, sha256 ${got}`);
	const parts = [];
	for (let i = 0; i * PART_BYTES < data.length; i++) {
		parts.push(`${file}.part${i}`);
		writeFileSync(new URL(parts[i], out), data.subarray(i * PART_BYTES, (i + 1) * PART_BYTES));
	}
	writeFileSync(manifestPath, JSON.stringify({ file, revision: REVISION, sha256, bytes, parts }));
	console.log(`fetched ${file} (${parts.length} part${parts.length > 1 ? "s" : ""}) into ${dir}/bee/`);
}
