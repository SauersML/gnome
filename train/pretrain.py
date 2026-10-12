"""Stage A: teaches BeeLLM 12M Mood English by continued pretraining on TinyStories, while a
share of every batch is bee chat (train/encode.mjs output) so the chat format and her moods
stay in use. Story windows train on every token; chats train on bee replies only.
Usage: python train/pretrain.py <base.gguf> <text.bin> <valid.bin> <chat.json> <out dir> <million tokens> [lr] [chat share]
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

BATCH = 4
ACCUMULATE = 8
WARMUP = 200
EVAL_EVERY = 250


def story_rows(tokens: np.ndarray, rng: random.Random, n: int, bos: int):
    rows = []
    for _ in range(n):
        start = rng.randrange(0, len(tokens) - MAX_LEN)
        rows.append(([bos] + tokens[start:start + MAX_LEN - 1].tolist(), None))
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
    os.makedirs(out, exist_ok=True)
    device = "mps" if torch.backends.mps.is_available() else "cpu"
    tokens = np.fromfile(text, dtype=np.uint16)
    valid_tokens = np.fromfile(valid, dtype=np.uint16)
    data = json.load(open(chat))
    gguf = Gguf(base)
    bee = Bee(gguf).to(device)
    rng = random.Random(0)
    bos = data["bos"]
    valid_rows = story_rows(valid_tokens, random.Random(1), 48, bos)
    steps = int(float(mtok) * 1e6 / (BATCH * ACCUMULATE * MAX_LEN))
    opt = torch.optim.AdamW(bee.parameters(), lr=lr, betas=(0.9, 0.95), weight_decay=0.1)
    sched = torch.optim.lr_scheduler.LambdaLR(opt, lambda s: min(1, (s + 1) / WARMUP) * (0.1 + 0.9 * 0.5 * (1 + math.cos(math.pi * min(s, steps) / steps))))
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
        if step % EVAL_EVERY == 0 or step == steps:
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
                else:
                    rows.extend(story_rows(tokens, rng, 1, bos))
            loss, _ = loss_of(bee, *to_batch(rows, device))
            (loss / ACCUMULATE).backward()
        torch.nn.utils.clip_grad_norm_(bee.parameters(), 1.0)
        opt.step()
        sched.step()


if __name__ == "__main__":
    main()
