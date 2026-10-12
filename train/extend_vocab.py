"""Grows a BeeLLM SPM vocabulary with BPE merges learned on English and bee text, and writes
a GGUF whose new tokens start with the mean embedding and output row of the two pieces they
merge. New tokens get scores below every existing token, in the order they were learned, so
llama.cpp's SPM tokenizer (and src/server/bee.ts) apply old merges first and new merges in
learned order. Merges stay inside a word (a "▁" can only start a token), as in the original.
Usage: python train/extend_vocab.py <in.gguf> <out.gguf> <new vocab size> <corpus.txt> <MB of corpus> <bee data.jsonl>...
"""
import heapq
import json
import re
import sys
from collections import Counter, defaultdict

import numpy as np

from gguf_io import Gguf

SP = "▁"
MAX_TOKEN_CHARS = 16
BEE_WEIGHT = 30  # bee conversations are small next to the stories; count each one this often


def ascii_text(s: str) -> str:
    s = re.sub("[‘’]", "'", s)
    s = re.sub("[“”]", '"', s)
    s = re.sub("[–—]", "-", s).replace("…", "...")
    return re.sub(r"\s+", " ", s).strip()


def units(text: str):
    """A text as the word units the tokenizer can never merge across: '▁' starts each word."""
    parts = text.replace(" ", SP).split(SP)
    return [p if i == 0 else SP + p for i, p in enumerate(parts) if p or i == 0] if text else []


class Spm:
    """llama.cpp's SPM merge loop (llm_tokenizer_spm_session), returning the merged symbols."""

    def __init__(self, scores: dict[str, float]):
        self.scores = scores

    def segment(self, text: str) -> list[str]:
        sym = list(text)
        nxt = list(range(1, len(sym))) + [-1]
        prv = list(range(-1, len(sym) - 1))
        live = [True] * len(sym)
        heap = []

        def add(l, r):
            if l < 0 or r < 0:
                return
            merged = sym[l] + sym[r]
            if merged in self.scores:
                heapq.heappush(heap, (-self.scores[merged], l, r, merged))

        for i in range(1, len(sym)):
            add(i - 1, i)
        while heap:
            _, l, r, merged = heapq.heappop(heap)
            if not (live[l] and live[r]) or sym[l] + sym[r] != merged:
                continue
            sym[l] = merged
            live[r] = False
            nxt[l] = nxt[r]
            if nxt[r] >= 0:
                prv[nxt[r]] = l
            add(prv[l], l)
            add(l, nxt[l])
        out, i = [], 0 if sym else -1
        while i >= 0:
            out.append(sym[i])
            i = nxt[i]
        return out


def main():
    src, dst, size, corpus, mb, *bee_files = sys.argv[1:]
    size, mb = int(size), float(mb)
    g = Gguf(src)
    tokens = list(g.meta["tokenizer.ggml.tokens"])
    scores = list(g.meta["tokenizer.ggml.scores"])
    types = list(g.meta["tokenizer.ggml.token_type"])
    normal = {t: s for t, s, ty in zip(tokens, scores, types) if ty == 1}

    counts = Counter()
    with open(corpus, "rb") as f:
        raw = f.read(int(mb * 1e6)).decode("utf-8", "ignore")
    for doc in raw.split("<|endoftext|>")[:-1]:
        counts.update(units(ascii_text(doc)))
    for path in bee_files:
        for line in open(path):
            for turn in json.loads(line)["turns"]:
                for _ in range(BEE_WEIGHT):
                    counts.update(units(ascii_text(turn["content"])))
    spm = Spm(normal)
    words = [(spm.segment(u), c) for u, c in counts.items() if u]
    print(f"{len(words)} distinct word units, {sum(c for _, c in words)} occurrences", flush=True)

    pair_count = Counter()
    where = defaultdict(set)
    for i, (sym, c) in enumerate(words):
        for a, b in zip(sym, sym[1:]):
            pair_count[(a, b)] += c
            where[(a, b)].add(i)

    def ok(a: str, b: str) -> bool:
        m = a + b
        return len(m) <= MAX_TOKEN_CHARS and m.isascii() and SP not in m[1:] and m not in normal and not any(ch in m for ch in "<>")

    new = []
    lowest = min(scores)
    while len(tokens) + len(new) < size:
        a, b = max((p for p in pair_count.items() if p[1] > 0 and ok(*p[0])), key=lambda p: (p[1], p[0]))[0]
        merged = a + b
        new.append((merged, a, b))
        for i in list(where[(a, b)]):
            sym, c = words[i]
            for x, y in zip(sym, sym[1:]):
                pair_count[(x, y)] -= c
            out, j = [], 0
            while j < len(sym):
                if j + 1 < len(sym) and sym[j] == a and sym[j + 1] == b:
                    out.append(merged)
                    j += 2
                else:
                    out.append(sym[j])
                    j += 1
            words[i] = (out, c)
            for x, y in zip(out, out[1:]):
                pair_count[(x, y)] += c
                where[(x, y)].add(i)
        del pair_count[(a, b)]
        where.pop((a, b), None)
        if len(new) % 250 == 0:
            print(f"{len(new)} merges, latest {merged!r}", flush=True)

    # Each new token starts as the mean of its two pieces, in both the embedding and the output.
    index = {t: i for i, t in enumerate(tokens)}
    byte_ids = {int(t[3:5], 16): i for i, (t, ty) in enumerate(zip(tokens, types)) if ty == 6}
    embd, outw = g.tensor("token_embd.weight"), g.tensor("output.weight")
    rows_e, rows_o = [], []

    def rows(piece: str):
        if piece in index:
            return [index[piece]]
        return [byte_ids[b] for b in piece.encode("utf-8")]  # a character that was never a token

    for merged, a, b in new:
        ids = rows(a) + rows(b)
        e = np.mean([embd[i] if i < len(embd) else rows_e[i - len(embd)] for i in ids], axis=0)
        o = np.mean([outw[i] if i < len(outw) else rows_o[i - len(outw)] for i in ids], axis=0)
        index[merged] = len(tokens) + len(rows_e)
        rows_e.append(e)
        rows_o.append(o)
    tokens += [m for m, _, _ in new]
    scores += [lowest - 1 - k for k in range(len(new))]
    types += [1] * len(new)
    tensors = {n: g.tensor(n) for n in g.tensors}
    tensors["token_embd.weight"] = np.vstack([embd, np.array(rows_e, dtype=np.float32)])
    tensors["output.weight"] = np.vstack([outw, np.array(rows_o, dtype=np.float32)])
    meta = {"tokenizer.ggml.tokens": tokens, "tokenizer.ggml.scores": scores, "tokenizer.ggml.token_type": types,
            "llama.vocab_size": len(tokens)}
    g.write_new(dst, meta, tensors)
    print(f"wrote {dst}: vocabulary {len(tokens)}; first new tokens {[m for m, _, _ in new[:15]]}")


if __name__ == "__main__":
    main()
