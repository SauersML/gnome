"""Mixed training on TinyStories windows and bee chat (train/encode.mjs output). Story windows
train on every token; chats train on bee replies only.
Stage A teaches BeeLLM 12M Mood English with a small chat share so the chat format and her
moods stay in use; stage B runs the same loop from stage A with a large chat share, so the
stories keep her English while she becomes Scintilla.
Usage: python train/pretrain.py <base.gguf> <text.bin> <valid.bin> <chat.json> <out dir> <million tokens> [lr] [chat share] [eval every]
"""
import json
import math
import os
import random
import sys
import time

import numpy as np
import torch

from gguf_io import Gguf
from model import Bee
from train import MAX_LEN, held_out_loss, loss_of, pack

# Rows per micro-batch (memory) and micro-batches per step; a step is always 32 rows.
BATCH = int(os.environ.get("BEE_BATCH", "4"))
ACCUMULATE = 32 // BATCH
# BEE_BF16=1 runs the forward and backward in bfloat16 autocast (weights stay float32).
BF16 = os.environ.get("BEE_BF16") == "1"
WARMUP = 200
# BEE_BOOKS=<tokens.bin> mixes in books she may learn from but must never be able to recite: a
# BEE_BOOKS_SHARE of rows come from them with the goldfish loss (Hans et al. 2024), which skips
# every token whose 13 preceding tokens hash to 0 mod 4. The same tokens are skipped on every pass,
# so no passage longer than a few words is ever trained whole.
BOOKS = os.environ.get("BEE_BOOKS")
BOOKS_SHARE = float(os.environ.get("BEE_BOOKS_SHARE", "0.2"))
GOLDFISH_CONTEXT, GOLDFISH_EVERY = 13, 4


def story_rows(tokens: np.ndarray, rng: random.Random, n: int, bos: int):
    rows = []
    for _ in range(n):
        start = rng.randrange(0, len(tokens) - MAX_LEN)
        rows.append(([bos] + tokens[start:start + MAX_LEN - 1].tolist(), None))
    return rows


def goldfish_rows(tokens: np.ndarray, rng: random.Random, n: int, bos: int):
    rows = []
    for s, _ in story_rows(tokens, rng, n, bos):
        # The first tokens of a window have no full context to hash, so they never train either.
        mask = [0.0 if t <= GOLDFISH_CONTEXT or hash(tuple(s[t - GOLDFISH_CONTEXT:t])) % GOLDFISH_EVERY == 0 else 1.0 for t in range(len(s))]
        rows.append((s, mask))
    return rows


def to_batch(rows, device):
    ids = torch.zeros(len(rows), MAX_LEN, dtype=torch.long)
    mask = torch.zeros(len(rows), MAX_LEN)
    for j, (s, m) in enumerate(rows):
        ids[j, :len(s)] = torch.tensor(s)
        mask[j, :len(s)] = 1 if m is None else torch.tensor(m, dtype=torch.float32)
    return ids.to(device), mask.to(device)


def main():
    base, text, valid, chat, out, mtok = sys.argv[1:7]
    lr = float(sys.argv[7]) if len(sys.argv) > 7 else 6e-4
    chat_share = float(sys.argv[8]) if len(sys.argv) > 8 else 0.15
    eval_every = int(sys.argv[9]) if len(sys.argv) > 9 else 250
    os.makedirs(out, exist_ok=True)
    device = os.environ.get("BEE_DEVICE") or ("mps" if torch.backends.mps.is_available() else "cpu")
    tokens = np.fromfile(text, dtype=np.uint16)
    valid_tokens = np.fromfile(valid, dtype=np.uint16)
    books = np.fromfile(BOOKS, dtype=np.uint16) if BOOKS else None
    data = json.load(open(chat))
    gguf = Gguf(base)
    bee = Bee(gguf).to(device)
    rng = random.Random(0)
    bos = data["bos"]
    valid_rows = story_rows(valid_tokens, random.Random(1), 48, bos)
    steps = int(float(mtok) * 1e6 / (BATCH * ACCUMULATE * MAX_LEN))
    opt = torch.optim.AdamW(bee.parameters(), lr=lr, betas=(0.9, 0.95), weight_decay=0.1)
    warmup = min(WARMUP, max(1, steps // 10))
    sched = torch.optim.lr_scheduler.LambdaLR(opt, lambda s: min(1, (s + 1) / warmup) * (0.1 + 0.9 * 0.5 * (1 + math.cos(math.pi * min(s, steps) / steps))))
    chats = []

    def story_loss():
        bee.eval()
        with torch.no_grad():
            total = sum(loss_of(bee, *to_batch(valid_rows[i:i + BATCH], device))[0].item() for i in range(0, len(valid_rows), BATCH))
        bee.train()
        return total / math.ceil(len(valid_rows) / BATCH)

    log = []
    t0 = time.time()
    for step in range(steps + 1):
        if step % eval_every == 0 or step == steps:
            entry = {"step": step, "tokens_m": round(step * BATCH * ACCUMULATE * MAX_LEN / 1e6, 1), "story": round(story_loss(), 3),
                     "chat_held_out": round(held_out_loss(bee, data["val"], bos, device), 3), "minutes": round((time.time() - t0) / 60, 1)}
            log.append(entry)
            print(json.dumps(entry), flush=True)
            gguf.write(f"{out}/step{step}.gguf", bee.tensors())
            json.dump(log, open(f"{out}/log.json", "w"), indent=1)
        if step == steps:
            break
        opt.zero_grad()
        for _ in range(ACCUMULATE):
            rows = []
            for _ in range(BATCH):
                if rng.random() < chat_share:
                    if not chats:
                        chats = pack(data["train"], bos, rng)
                    rows.append(chats.pop())
                elif books is not None and rng.random() < BOOKS_SHARE / (1 - chat_share):
                    rows.extend(goldfish_rows(books, rng, 1, bos))
                else:
                    rows.extend(story_rows(tokens, rng, 1, bos))
            with torch.autocast(device_type=device, dtype=torch.bfloat16, enabled=BF16):
                loss, _ = loss_of(bee, *to_batch(rows, device))
            (loss / ACCUMULATE).backward()
        torch.nn.utils.clip_grad_norm_(bee.parameters(), 1.0)
        opt.step()
        sched.step()


if __name__ == "__main__":
    main()
