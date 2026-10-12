"""Post-trains BeeLLM 12M Mood on encoded conversations (train/encode.mjs) and writes GGUFs.

Conversations are packed after a single <s> into sequences of up to MAX_LEN tokens, so the
model also learns to answer after unrelated earlier conversations, which is how the
delve.town bee's memory reaches her prompt. Loss covers bee replies only. A checkpoint is
written after every epoch along with its held-out loss.
Usage: python train/train.py <base.gguf> <encoded.json> <out dir> [epochs] [lr]
"""
import json
import math
import os
import random
import sys
import time

import torch
import torch.nn.functional as F

from gguf_io import Gguf
from model import Bee

MAX_LEN = 896
BATCH = 4  # micro-batch; ACCUMULATE of them make one optimizer step
ACCUMULATE = 4
WARMUP = 30
SINGLE = 0.4  # fraction of sequences holding one conversation, as when her memory is empty


def pack(convs, bos, rng):
    order = list(convs)
    rng.shuffle(order)
    seqs, ids, mask = [], [bos], [0]
    for c in order:
        if len(ids) + len(c["ids"]) > MAX_LEN or (len(ids) > 1 and rng.random() < SINGLE):
            if len(ids) > 1:
                seqs.append((ids, mask))
            ids, mask = [bos], [0]
        ids, mask = ids + c["ids"][-(MAX_LEN - 1):], mask + c["mask"][-(MAX_LEN - 1):]
    if len(ids) > 1:
        seqs.append((ids, mask))
    return seqs


def batches(seqs, device):
    for i in range(0, len(seqs), BATCH):
        chunk = seqs[i:i + BATCH]
        # One fixed shape: the MPS backend keeps memory for every distinct shape it sees.
        T = MAX_LEN
        ids = torch.zeros(len(chunk), T, dtype=torch.long)
        mask = torch.zeros(len(chunk), T)
        for j, (s, m) in enumerate(chunk):
            ids[j, :len(s)] = torch.tensor(s)
            mask[j, :len(m)] = torch.tensor(m, dtype=torch.float32)
        yield ids.to(device), mask.to(device)


def loss_of(bee, ids, mask):
    logits = bee(ids[:, :-1])
    nll = F.cross_entropy(logits.reshape(-1, logits.shape[-1]), ids[:, 1:].reshape(-1), reduction="none")
    m = mask[:, 1:].reshape(-1)
    return (nll * m).sum() / m.sum().clamp(min=1), m.sum()


def held_out_loss(bee, convs, bos, device):
    bee.eval()
    total, count = 0.0, 0.0
    with torch.no_grad():
        for ids, mask in batches([([bos] + c["ids"], [0] + c["mask"]) for c in convs], device):
            loss, n = loss_of(bee, ids, mask)
            total += loss.item() * n.item()
            count += n.item()
    bee.train()
    return total / count


def main():
    base, encoded, out = sys.argv[1:4]
    epochs = int(sys.argv[4]) if len(sys.argv) > 4 else 6
    lr = float(sys.argv[5]) if len(sys.argv) > 5 else 2e-4
    os.makedirs(out, exist_ok=True)
    device = "mps" if torch.backends.mps.is_available() else "cpu"
    data = json.load(open(encoded))
    gguf = Gguf(base)
    bee = Bee(gguf).to(device)
    rng = random.Random(0)
    steps_per_epoch = math.ceil(len(pack(data["train"], data["bos"], random.Random(1))) / (BATCH * ACCUMULATE))
    total = steps_per_epoch * epochs
    opt = torch.optim.AdamW(bee.parameters(), lr=lr, betas=(0.9, 0.95), weight_decay=0.01)
    sched = torch.optim.lr_scheduler.LambdaLR(opt, lambda s: min(1, (s + 1) / WARMUP) * (0.1 + 0.9 * 0.5 * (1 + math.cos(math.pi * min(s, total) / total))))
    log = [{"epoch": 0, "held_out": held_out_loss(bee, data["val"], data["bos"], device)}]
    print(json.dumps(log[-1]), flush=True)
    step = 0
    for epoch in range(1, epochs + 1):
        t0, seen, running = time.time(), 0, 0.0
        micro = list(batches(pack(data["train"], data["bos"], rng), device))
        for i in range(0, len(micro), ACCUMULATE):
            opt.zero_grad()
            group = micro[i:i + ACCUMULATE]
            for ids, mask in group:
                loss, _ = loss_of(bee, ids, mask)
                (loss / len(group)).backward()
                running += loss.item() / len(group)
            torch.nn.utils.clip_grad_norm_(bee.parameters(), 1.0)
            opt.step()
            sched.step()
            step += 1
            seen += 1
        log.append({"epoch": epoch, "train": running / seen, "held_out": held_out_loss(bee, data["val"], data["bos"], device), "seconds": round(time.time() - t0, 1)})
        print(json.dumps(log[-1]), flush=True)
        gguf.write(f"{out}/epoch{epoch}.gguf", bee.tensors())
    json.dump(log, open(f"{out}/log.json", "w"), indent=1)


if __name__ == "__main__":
    main()
