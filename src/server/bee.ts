// BeeLLM (https://huggingface.co/schizophyllume/BeeLLM) run directly in the Worker: a GGUF
// reader, llama.cpp's SPM tokenizer, the llama forward pass in F32 (matrices F32 or Q8_0),
// and llama-server's default sampler chain. The Mood bees chat through <|user|>/<|bee|>
// turns; the tiny bees (30P, 42P, 42P Chaos) have no chat template and continue raw buzzing.

export type BeeTurn = { role: "user" | "bee"; content: string };

type Tensor = { dims: number[]; type: number; offset: number };
// A Q8_0 matrix as the file's bytes: block k (32 weights along a row) is an f16 scale then 32
// int8 at q[k*34 + 2..]; its scale, decoded once, is d[k].
type Q8 = { q: Int8Array; d: Float32Array };
type Weight = Float32Array | Q8;

const GGUF_MAGIC = 0x46554747; // "GGUF"
const GGML_TYPE_F32 = 0;
const GGML_TYPE_Q8_0 = 8;
const QK8_0 = 32;
const TOKEN_NORMAL = 1;
const TOKEN_CONTROL = 3;
const TOKEN_BYTE = 6;

// repeatPenalty divides positive logits (and multiplies negative ones) of tokens among the last
// repeatLastN tokens of the reply, as llama.cpp's repeat_penalty does; 1 turns it off.
// loopLimit ends a reply once a pattern of 1-4 tokens has repeated that many times in a row,
// keeping four repeats; unset means replies end only at </s> or the length limit.
// firstTemperature, when set, samples a reply's first token (a Mood bee's [mood:level] tag) at
// that temperature and the rest at `temperature`.
export type Sampling = { topK: number; topP: number; minP: number; temperature: number; repeatPenalty?: number; repeatLastN?: number; loopLimit?: number; firstTemperature?: number };

// Number of trailing tokens to drop when the end of `ids` repeats a 1-4 token pattern `limit`
// times in a row (all but four repeats), or 0.
export function loopExcess(ids: number[], limit: number): number {
	for (let k = 1; k <= 4; k++) {
		if (ids.length < k * limit) continue;
		let repeats = 1;
		while (repeats < limit) {
			const end = ids.length - repeats * k;
			let same = true;
			for (let i = 0; i < k && same; i++) same = ids[end - k + i] === ids[ids.length - k + i];
			if (!same) break;
			repeats++;
		}
		if (repeats >= limit) return (limit - 4) * k;
	}
	return 0;
}
// llama-server defaults: top_k 40 -> top_p 0.95 -> min_p 0.05 -> temperature 0.8.
export const LLAMA_SERVER_SAMPLING: Sampling = { topK: 40, topP: 0.95, minP: 0.05, temperature: 0.8 };
export const MAX_PROMPT_TOKENS = 512;
export const MAX_REPLY_TOKENS = 160;

function readGguf(buffer: ArrayBuffer) {
	const view = new DataView(buffer);
	const bytes = new Uint8Array(buffer);
	const utf8 = new TextDecoder();
	let pos = 0;
	const u32 = () => { const v = view.getUint32(pos, true); pos += 4; return v; };
	const u64 = () => { const v = Number(view.getBigUint64(pos, true)); pos += 8; return v; };
	const str = () => { const n = u64(); const s = utf8.decode(bytes.subarray(pos, pos + n)); pos += n; return s; };
	const value = (type: number): unknown => {
		switch (type) {
			case 0: return view.getUint8(pos++);
			case 1: return view.getInt8(pos++);
			case 2: { const v = view.getUint16(pos, true); pos += 2; return v; }
			case 3: { const v = view.getInt16(pos, true); pos += 2; return v; }
			case 4: return u32();
			case 5: { const v = view.getInt32(pos, true); pos += 4; return v; }
			case 6: { const v = view.getFloat32(pos, true); pos += 4; return v; }
			case 7: return view.getUint8(pos++) !== 0;
			case 8: return str();
			case 9: { const t = u32(); const n = u64(); const a: unknown[] = new Array(n); for (let i = 0; i < n; i++) a[i] = value(t); return a; }
			case 10: return u64();
			case 11: { const v = Number(view.getBigInt64(pos, true)); pos += 8; return v; }
			case 12: { const v = view.getFloat64(pos, true); pos += 8; return v; }
			default: throw new Error(`Unknown GGUF value type ${type}`);
		}
	};
	if (u32() !== GGUF_MAGIC) throw new Error("Not a GGUF file");
	const version = u32();
	if (version !== 3) throw new Error(`Unsupported GGUF version ${version}`);
	const nTensors = u64();
	const nKv = u64();
	const meta = new Map<string, unknown>();
	for (let i = 0; i < nKv; i++) { const key = str(); meta.set(key, value(u32())); }
	const infos: { name: string; dims: number[]; type: number; offset: number }[] = [];
	for (let i = 0; i < nTensors; i++) {
		const name = str();
		const nd = u32();
		const dims: number[] = [];
		for (let d = 0; d < nd; d++) dims.push(u64());
		const type = u32();
		if (type !== GGML_TYPE_F32 && type !== GGML_TYPE_Q8_0) throw new Error(`Tensor ${name} is type ${type}; only F32 and Q8_0 are supported`);
		infos.push({ name, dims, type, offset: u64() });
	}
	const alignment = (meta.get("general.alignment") as number | undefined) ?? 32;
	const dataStart = Math.ceil(pos / alignment) * alignment;
	const tensors = new Map<string, Tensor>();
	for (const t of infos) tensors.set(t.name, { dims: t.dims, type: t.type, offset: dataStart + t.offset });
	return { meta, tensors };
}

function logProb(logits: Float32Array, id: number): number {
	let max = -Infinity;
	for (let i = 0; i < logits.length; i++) if (logits[i] > max) max = logits[i];
	let sum = 0;
	for (let i = 0; i < logits.length; i++) sum += Math.exp(logits[i] - max);
	return logits[id] - max - Math.log(sum);
}

// The value of an f16 given its 16 bits.
function f16(h: number): number {
	const e = (h >> 10) & 31, m = h & 1023, sign = h & 0x8000 ? -1 : 1;
	if (e === 0) return sign * m * 2 ** -24;
	if (e === 31) return m ? NaN : sign * Infinity;
	return sign * (1024 + m) * 2 ** (e - 25);
}

// y[t*nOut + o] = sum_i w[o*nIn + i] * x[t*nIn + i] for T rows of x.
function matmul(y: Float32Array, x: Float32Array, w: Weight, T: number, nIn: number, nOut: number) {
	if (w instanceof Float32Array) matmulF32(y, x, w, T, nIn, nOut);
	else matmulQ8(y, x, w, T, nIn, nOut);
}

function matmulF32(y: Float32Array, x: Float32Array, w: Float32Array, T: number, nIn: number, nOut: number) {
	for (let o = 0; o < nOut; o++) {
		const wo = o * nIn;
		for (let t = 0; t < T; t++) {
			const xo = t * nIn;
			let s0 = 0, s1 = 0, s2 = 0, s3 = 0;
			let i = 0;
			for (; i + 3 < nIn; i += 4) {
				s0 += w[wo + i] * x[xo + i];
				s1 += w[wo + i + 1] * x[xo + i + 1];
				s2 += w[wo + i + 2] * x[xo + i + 2];
				s3 += w[wo + i + 3] * x[xo + i + 3];
			}
			for (; i < nIn; i++) s0 += w[wo + i] * x[xo + i];
			y[t * nOut + o] = s0 + s1 + s2 + s3;
		}
	}
}

// Each 32-weight block is its scale times int8 weights, applied to F32 x: the exact product with
// the dequantized matrix, as llama.cpp computes it on GPUs. (Its CPU backend also rounds x to
// Q8_0, which moves low log-probabilities by up to about 0.1.)
function matmulQ8(y: Float32Array, x: Float32Array, w: Q8, T: number, nIn: number, nOut: number) {
	const { q, d } = w, nb = nIn / QK8_0;
	for (let o = 0; o < nOut; o++) {
		for (let t = 0; t < T; t++) {
			let s = 0;
			for (let b = 0; b < nb; b++) {
				const k = o * nb + b, qo = k * 34 + 2, xo = t * nIn + b * QK8_0;
				let s0 = 0, s1 = 0, s2 = 0, s3 = 0;
				for (let i = 0; i < QK8_0; i += 4) {
					s0 += q[qo + i] * x[xo + i];
					s1 += q[qo + i + 1] * x[xo + i + 1];
					s2 += q[qo + i + 2] * x[xo + i + 2];
					s3 += q[qo + i + 3] * x[xo + i + 3];
				}
				s += d[k] * (s0 + s1 + s2 + s3);
			}
			y[t * nOut + o] = s;
		}
	}
}

// Copies row `row` of an n-wide matrix (an embedding) into out at `at`.
function copyRow(out: Float32Array, at: number, w: Weight, row: number, n: number) {
	if (w instanceof Float32Array) {
		out.set(w.subarray(row * n, row * n + n), at);
		return;
	}
	const nb = n / QK8_0;
	for (let b = 0; b < nb; b++) {
		const k = row * nb + b, qo = k * 34 + 2;
		for (let i = 0; i < QK8_0; i++) out[at + b * QK8_0 + i] = w.d[k] * w.q[qo + i];
	}
}

function rmsNorm(out: Float32Array, x: Float32Array, weight: Float32Array, T: number, n: number, eps: number) {
	for (let t = 0; t < T; t++) {
		const o = t * n;
		let ss = 0;
		for (let i = 0; i < n; i++) ss += x[o + i] * x[o + i];
		const scale = 1 / Math.sqrt(ss / n + eps);
		for (let i = 0; i < n; i++) out[o + i] = x[o + i] * scale * weight[i];
	}
}

type Layer = {
	attnNorm: Float32Array; q: Weight; k: Weight; v: Weight; o: Weight;
	ffnNorm: Float32Array; gate: Weight; up: Weight; down: Weight;
};

export class BeeModel {
	readonly nEmbd: number;
	readonly nLayer: number;
	readonly nHead: number;
	readonly nFf: number;
	readonly nVocab: number;
	readonly eps: number;
	readonly ropeBase: number;
	readonly bos: number;
	readonly eos: number;
	readonly userToken: number;
	readonly beeToken: number;
	// Whether the model has the <|user|>/<|bee|> chat template (the Mood bees).
	readonly chat: boolean;
	// llama.cpp's SPM default is a leading space on each text fragment unless the GGUF says otherwise.
	readonly addSpacePrefix: boolean;
	private readonly tokens: string[];
	private readonly tokenTypes: number[];
	private readonly mergeable = new Map<string, { id: number; score: number }>();
	private readonly byteTokens: number[] = [];
	private readonly embd: Weight;
	private readonly outNorm: Float32Array;
	private readonly output: Weight;
	private readonly layers: Layer[] = [];
	private readonly ropeCos: Float32Array;
	private readonly ropeSin: Float32Array;
	private readonly ctx: number;
	private readonly kCache: Float32Array[] = [];
	private readonly vCache: Float32Array[] = [];

	readonly sampling: Sampling;

	constructor(buffer: ArrayBuffer, ctx = MAX_PROMPT_TOKENS + MAX_REPLY_TOKENS, sampling: Sampling = LLAMA_SERVER_SAMPLING) {
		this.sampling = sampling;
		const { meta, tensors } = readGguf(buffer);
		if (meta.get("general.architecture") !== "llama") throw new Error("Expected a llama GGUF");
		if (meta.get("tokenizer.ggml.model") !== "llama") throw new Error("Expected an SPM (llama) tokenizer");
		const num = (key: string) => meta.get(key) as number;
		this.nEmbd = num("llama.embedding_length");
		this.nLayer = num("llama.block_count");
		this.nHead = num("llama.attention.head_count");
		this.nFf = num("llama.feed_forward_length");
		if (num("llama.attention.head_count_kv") !== this.nHead) throw new Error("Grouped-query attention is not supported");
		const headDim = this.nEmbd / this.nHead;
		if ((meta.get("llama.rope.dimension_count") ?? headDim) !== headDim) throw new Error("Partial rotary embedding is not supported");
		this.eps = num("llama.attention.layer_norm_rms_epsilon");
		this.ropeBase = (meta.get("llama.rope.freq_base") as number | undefined) ?? 10000;
		this.addSpacePrefix = (meta.get("tokenizer.ggml.add_space_prefix") as boolean | undefined) ?? true;
		this.bos = num("tokenizer.ggml.bos_token_id");
		this.eos = num("tokenizer.ggml.eos_token_id");
		this.tokens = meta.get("tokenizer.ggml.tokens") as string[];
		this.tokenTypes = meta.get("tokenizer.ggml.token_type") as number[];
		const scores = meta.get("tokenizer.ggml.scores") as number[];
		this.nVocab = this.tokens.length;
		for (let id = 0; id < this.nVocab; id++) {
			const type = this.tokenTypes[id];
			if (type === TOKEN_BYTE) this.byteTokens[parseInt(this.tokens[id].slice(3, 5), 16)] = id;
			// Control tokens are never formed from typed text, so chat text cannot forge turns.
			else if (type === TOKEN_NORMAL) this.mergeable.set(this.tokens[id], { id, score: scores[id] });
		}
		this.userToken = this.tokens.indexOf("<|user|>");
		this.beeToken = this.tokens.indexOf("<|bee|>");
		this.chat = this.userToken >= 0 && this.beeToken >= 0;
		if (this.byteTokens.filter((id) => id !== undefined).length !== 256) throw new Error("Missing byte-fallback tokens");

		const tensor = (name: string, dims: number[]) => {
			const t = tensors.get(name);
			if (!t || t.dims.join() !== dims.join()) throw new Error(`Tensor ${name} has dims ${t?.dims} instead of ${dims}`);
			return { ...t, n: dims.reduce((a, b) => a * b, 1) };
		};
		const f32 = (name: string, ...dims: number[]) => {
			const t = tensor(name, dims);
			if (t.type !== GGML_TYPE_F32) throw new Error(`Tensor ${name} must be F32`);
			return new Float32Array(buffer, t.offset, t.n);
		};
		// Matrices may be Q8_0 (train/quantize.py): views on the file's bytes plus decoded scales.
		const weight = (name: string, ...dims: number[]): Weight => {
			const t = tensor(name, dims);
			if (t.type === GGML_TYPE_F32) return new Float32Array(buffer, t.offset, t.n);
			if (dims[0] % QK8_0) throw new Error(`Tensor ${name} rows are not whole Q8_0 blocks`);
			const blocks = t.n / QK8_0, view = new DataView(buffer, t.offset, blocks * 34), d = new Float32Array(blocks);
			for (let k = 0; k < blocks; k++) d[k] = f16(view.getUint16(k * 34, true));
			return { q: new Int8Array(buffer, t.offset, blocks * 34), d };
		};
		const d = this.nEmbd;
		this.embd = weight("token_embd.weight", d, this.nVocab);
		this.outNorm = f32("output_norm.weight", d);
		this.output = weight("output.weight", d, this.nVocab);
		for (let l = 0; l < this.nLayer; l++) {
			const p = `blk.${l}.`;
			this.layers.push({
				attnNorm: f32(`${p}attn_norm.weight`, d),
				q: weight(`${p}attn_q.weight`, d, d), k: weight(`${p}attn_k.weight`, d, d),
				v: weight(`${p}attn_v.weight`, d, d), o: weight(`${p}attn_output.weight`, d, d),
				ffnNorm: f32(`${p}ffn_norm.weight`, d),
				gate: weight(`${p}ffn_gate.weight`, d, this.nFf), up: weight(`${p}ffn_up.weight`, d, this.nFf),
				down: weight(`${p}ffn_down.weight`, this.nFf, d),
			});
			this.kCache.push(new Float32Array(ctx * d));
			this.vCache.push(new Float32Array(ctx * d));
		}
		this.ctx = ctx;
		// ggml "normal" rope: adjacent pairs (2i, 2i+1) rotate by pos * base^(-2i/headDim).
		const half = headDim / 2;
		this.ropeCos = new Float32Array(ctx * half);
		this.ropeSin = new Float32Array(ctx * half);
		for (let p = 0; p < ctx; p++) {
			for (let i = 0; i < half; i++) {
				const theta = p * Math.pow(this.ropeBase, (-2 * i) / headDim);
				this.ropeCos[p * half + i] = Math.cos(theta);
				this.ropeSin[p * half + i] = Math.sin(theta);
			}
		}
	}

	// llama.cpp's SPM tokenizer (llm_tokenizer_spm_session) on one raw-text fragment.
	tokenize(text: string): number[] {
		if (!text) return [];
		const chars = Array.from((this.addSpacePrefix ? " " + text : text).replace(/ /g, "▁"));
		const sym = chars.map((c, i) => ({ text: c, prev: i - 1, next: i + 1 < chars.length ? i + 1 : -1, live: true }));
		type Bigram = { left: number; right: number; score: number; text: string };
		const heap: Bigram[] = [];
		const better = (a: Bigram, b: Bigram) => a.score > b.score || (a.score === b.score && a.left < b.left);
		const push = (b: Bigram) => {
			heap.push(b);
			for (let i = heap.length - 1; i > 0;) {
				const p = (i - 1) >> 1;
				if (!better(heap[i], heap[p])) break;
				[heap[i], heap[p]] = [heap[p], heap[i]];
				i = p;
			}
		};
		const pop = () => {
			const top = heap[0];
			const last = heap.pop()!;
			if (heap.length) {
				heap[0] = last;
				for (let i = 0; ;) {
					const l = 2 * i + 1, r = l + 1;
					let m = i;
					if (l < heap.length && better(heap[l], heap[m])) m = l;
					if (r < heap.length && better(heap[r], heap[m])) m = r;
					if (m === i) break;
					[heap[i], heap[m]] = [heap[m], heap[i]];
					i = m;
				}
			}
			return top;
		};
		const tryAdd = (left: number, right: number) => {
			if (left < 0 || right < 0) return;
			const merged = sym[left].text + sym[right].text;
			const tok = this.mergeable.get(merged);
			if (tok) push({ left, right, score: tok.score, text: merged });
		};
		for (let i = 1; i < sym.length; i++) tryAdd(i - 1, i);
		while (heap.length) {
			const b = pop();
			const l = sym[b.left], r = sym[b.right];
			if (!l.live || !r.live || l.text + r.text !== b.text) continue;
			l.text = b.text;
			r.live = false;
			l.next = r.next;
			if (r.next >= 0) sym[r.next].prev = b.left;
			tryAdd(l.prev, b.left);
			tryAdd(b.left, l.next);
		}
		const out: number[] = [];
		const utf8 = new TextEncoder();
		for (let i = 0; i >= 0; i = sym[i].next) {
			const tok = this.mergeable.get(sym[i].text);
			if (tok) out.push(tok.id);
			else for (const byte of utf8.encode(sym[i].text)) out.push(this.byteTokens[byte]);
		}
		return out;
	}

	detokenize(ids: number[]): string {
		const bytes: number[] = [];
		const utf8 = new TextEncoder();
		for (const id of ids) {
			const type = this.tokenTypes[id];
			if (type === TOKEN_BYTE) bytes.push(parseInt(this.tokens[id].slice(3, 5), 16));
			else if (type === TOKEN_NORMAL) bytes.push(...utf8.encode(this.tokens[id].replace(/▁/g, " ")));
		}
		return new TextDecoder().decode(new Uint8Array(bytes));
	}

	// The GGUF chat template: <s> then <|user|>text and <|bee|>text</s> turns, ending with <|bee|>.
	// Oldest turns are dropped until the prompt fits.
	promptTokens(turns: BeeTurn[], maxTokens = MAX_PROMPT_TOKENS): number[] {
		if (!this.chat) throw new Error("This bee has no chat template");
		const encoded = turns.map((t) => t.role === "user"
			? [this.userToken, ...this.tokenize(t.content)]
			: [this.beeToken, ...this.tokenize(t.content), this.eos]);
		let start = 0;
		const total = () => 2 + encoded.slice(start).reduce((n, e) => n + e.length, 0);
		while (start < encoded.length - 1 && total() > maxTokens) start++;
		const ids = [this.bos, ...encoded.slice(start).flat(), this.beeToken];
		return ids.length > maxTokens ? [this.bos, ...ids.slice(ids.length - maxTokens + 1)] : ids;
	}

	// Runs tokens at positions pos0.. through the model, filling the KV cache.
	// Returns the logits of the last position.
	forward(ids: number[], pos0: number): Float32Array {
		const T = ids.length, d = this.nEmbd, ff = this.nFf, H = this.nHead, hd = d / H, half = hd / 2;
		if (pos0 + T > this.ctx) throw new Error("Context is full");
		const x = new Float32Array(T * d);
		const h = new Float32Array(T * d);
		const q = new Float32Array(T * d);
		const att = new Float32Array(T * d);
		const proj = new Float32Array(T * d);
		const g = new Float32Array(T * ff);
		const u = new Float32Array(T * ff);
		const scores = new Float32Array(pos0 + T);
		const scale = 1 / Math.sqrt(hd);
		for (let t = 0; t < T; t++) copyRow(x, t * d, this.embd, ids[t], d);
		for (let l = 0; l < this.nLayer; l++) {
			const L = this.layers[l], kc = this.kCache[l], vc = this.vCache[l];
			rmsNorm(h, x, L.attnNorm, T, d, this.eps);
			matmul(q, h, L.q, T, d, d);
			matmul(kc.subarray(pos0 * d), h, L.k, T, d, d);
			matmul(vc.subarray(pos0 * d), h, L.v, T, d, d);
			for (let t = 0; t < T; t++) {
				const p = pos0 + t;
				for (const buf of [q.subarray(t * d), kc.subarray(p * d)]) {
					for (let hh = 0; hh < H; hh++) {
						for (let i = 0; i < half; i++) {
							const a = hh * hd + 2 * i, c = this.ropeCos[p * half + i], s = this.ropeSin[p * half + i];
							const x0 = buf[a], x1 = buf[a + 1];
							buf[a] = x0 * c - x1 * s;
							buf[a + 1] = x0 * s + x1 * c;
						}
					}
				}
			}
			for (let t = 0; t < T; t++) {
				const n = pos0 + t + 1;
				for (let hh = 0; hh < H; hh++) {
					const qo = t * d + hh * hd;
					let max = -Infinity;
					for (let j = 0; j < n; j++) {
						let s = 0;
						const ko = j * d + hh * hd;
						for (let i = 0; i < hd; i++) s += q[qo + i] * kc[ko + i];
						scores[j] = s * scale;
						if (scores[j] > max) max = scores[j];
					}
					let sum = 0;
					for (let j = 0; j < n; j++) { scores[j] = Math.exp(scores[j] - max); sum += scores[j]; }
					const ao = t * d + hh * hd;
					for (let i = 0; i < hd; i++) att[ao + i] = 0;
					for (let j = 0; j < n; j++) {
						const wgt = scores[j] / sum, vo = j * d + hh * hd;
						for (let i = 0; i < hd; i++) att[ao + i] += wgt * vc[vo + i];
					}
				}
			}
			matmul(proj, att, L.o, T, d, d);
			for (let i = 0; i < T * d; i++) x[i] += proj[i];
			rmsNorm(h, x, L.ffnNorm, T, d, this.eps);
			matmul(g, h, L.gate, T, d, ff);
			matmul(u, h, L.up, T, d, ff);
			for (let i = 0; i < T * ff; i++) g[i] = (g[i] / (1 + Math.exp(-g[i]))) * u[i];
			matmul(proj, g, L.down, T, ff, d);
			for (let i = 0; i < T * d; i++) x[i] += proj[i];
		}
		const last = new Float32Array(d);
		rmsNorm(last, x.subarray((T - 1) * d), this.outNorm, 1, d, this.eps);
		const logits = new Float32Array(this.nVocab);
		matmul(logits, last, this.output, 1, d, this.nVocab);
		return logits;
	}

	sample(logits: Float32Array, random: () => number, recent: number[] = [], temperature = this.sampling.temperature): number {
		const { topK, topP, minP, repeatPenalty = 1, repeatLastN = 64 } = this.sampling;
		if (repeatPenalty !== 1 && recent.length) {
			logits = logits.slice();
			for (const id of new Set(recent.slice(-repeatLastN))) logits[id] = logits[id] > 0 ? logits[id] / repeatPenalty : logits[id] * repeatPenalty;
		}
		const ids = Array.from(logits.keys()).sort((a, b) => logits[b] - logits[a]).slice(0, topK);
		const max = logits[ids[0]];
		const p = ids.map((id) => Math.exp(logits[id] - max));
		const z = p.reduce((a, b) => a + b, 0);
		let keep = ids.length, cum = 0;
		for (let i = 0; i < ids.length; i++) {
			cum += p[i] / z;
			if (cum >= topP) { keep = i + 1; break; }
		}
		const kept = ids.slice(0, keep).filter((id) => logits[id] - max >= Math.log(minP));
		const w = kept.map((id) => Math.exp((logits[id] - max) / temperature));
		let r = random() * w.reduce((a, b) => a + b, 0);
		for (let i = 0; i < kept.length; i++) {
			r -= w[i];
			if (r <= 0) return kept[i];
		}
		return kept[kept.length - 1];
	}

	// Mean log-probability per token of `reply` (its end included) right after `prefix`.
	private meanLogProb(prefix: number[], reply: number[]): number {
		const ids = [...prefix, ...reply];
		let logits = this.forward(prefix, 0), total = 0;
		for (let i = prefix.length; i <= ids.length; i++) {
			const next = i < ids.length ? ids[i] : this.eos;
			total += logProb(logits, next);
			if (i < ids.length) logits = this.forward([ids[i]], i);
		}
		return total / (reply.length + 1);
	}

	// Samples `candidates` replies from one pass over the prompt and keeps the best: the most
	// fluent (highest mean log-probability per token, the end of reply included), or, with
	// `relevance` > 0, the one that much more likely after this prompt than after an empty one,
	// which favours replies about what was actually said over replies that fit any post, less
	// `penalty(text)` (the bees': half-words, broken openings and repeated clauses, src/server/garble.ts).
	private generate(prompt: number[], maxTokens: number, random: () => number, candidates = 1, relevance = 0, penalty?: (text: string) => number): string {
		const first = this.forward(prompt, 0);
		const drafts: { ids: number[]; score: number }[] = [];
		for (let c = 0; c < candidates; c++) {
			let logits = first;
			const out: number[] = [];
			let logp = 0, steps = 0;
			for (let pos = prompt.length; out.length < maxTokens; pos++) {
				const id = this.sample(logits, random, out, out.length === 0 ? this.sampling.firstTemperature ?? this.sampling.temperature : this.sampling.temperature);
				logp += logProb(logits, id);
				steps++;
				if (id === this.eos || this.tokenTypes[id] === TOKEN_CONTROL) break;
				out.push(id);
				const excess = this.sampling.loopLimit ? loopExcess(out, this.sampling.loopLimit) : 0;
				if (excess) {
					out.length -= excess;
					break;
				}
				logits = this.forward([id], pos);
			}
			drafts.push({ ids: out, score: logp / steps });
		}
		if (relevance > 0 && this.chat && candidates > 1) {
			for (const d of drafts) d.score -= relevance * this.meanLogProb([this.bos, this.beeToken], d.ids);
		}
		if (penalty && candidates > 1) for (const d of drafts) d.score -= penalty(this.detokenize(d.ids));
		const best = drafts.reduce((a, b) => (b.score > a.score ? b : a));
		return this.detokenize(best.ids).trim();
	}

	reply(turns: BeeTurn[], random: () => number = Math.random, maxPromptTokens = MAX_PROMPT_TOKENS, candidates = 1, relevance = 0, penalty?: (text: string) => number): string {
		return this.generate(this.promptTokens(turns, maxPromptTokens), MAX_REPLY_TOKENS, random, candidates, relevance, penalty);
	}

	// For bees without a chat template: continue <s> + text, as llama.cpp's /completion does.
	continueText(text: string, maxTokens: number, random: () => number = Math.random, maxPromptTokens = 128): string {
		const ids = this.tokenize(text);
		return this.generate([this.bos, ...ids.slice(-(maxPromptTokens - 1))], maxTokens, random);
	}
}
