// Downloads the pinned BeeLLM 12M Mood weights, verifies them, and writes them to
// public/bee/ in parts below the 25 MiB static-asset limit. Skips work when present.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const REVISION = "62fc7082eebc184cc5177a67107318196aee69f7";
const FILE = "BeeLLM-12M-Mood.gguf";
const SHA256 = "32d5e894913620beab6b7eda374598a538285217b893ce5f3c7c21d1ef98879b";
const BYTES = 47913376;
const PART_BYTES = 24 * 1024 * 1024;
const DIR = new URL("../public/bee/", import.meta.url);

const manifestPath = new URL("manifest.json", DIR);
if (existsSync(manifestPath) && JSON.parse(readFileSync(manifestPath, "utf8")).sha256 === SHA256) process.exit(0);

const url = `https://huggingface.co/schizophyllume/BeeLLM/resolve/${REVISION}/${FILE}`;
const res = await fetch(url);
if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
const data = Buffer.from(await res.arrayBuffer());
const sha256 = createHash("sha256").update(data).digest("hex");
if (data.length !== BYTES || sha256 !== SHA256) throw new Error(`${FILE}: got ${data.length} bytes, sha256 ${sha256}`);

mkdirSync(DIR, { recursive: true });
const parts = [];
for (let i = 0; i * PART_BYTES < data.length; i++) {
	parts.push(`${FILE}.part${i}`);
	writeFileSync(new URL(parts[i], DIR), data.subarray(i * PART_BYTES, (i + 1) * PART_BYTES));
}
writeFileSync(manifestPath, JSON.stringify({ file: FILE, revision: REVISION, sha256, bytes: data.length, parts }));
console.log(`fetched ${FILE} (${parts.length} parts)`);
