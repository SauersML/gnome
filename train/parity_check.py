"""Checks the PyTorch model against llama.cpp's next-token log-probabilities (from tests/bee.test.mjs)."""
import sys

import torch

from gguf_io import Gguf
from model import Bee

IDS = [1, 3, 1991, 539, 271, 1991, 4, 2010, 279, 2009, 284, 2011, 267, 301, 293, 1991, 327, 291, 2, 3, 983, 4]
TOP = [(2010, -0.01208), (2, -4.42223), (410, -14.61032), (283, -15.10869), (267, -15.27159)]

bee = Bee(Gguf(sys.argv[1]))
with torch.no_grad():
    logp = torch.log_softmax(bee(torch.tensor([IDS]))[0, -1], -1)
worst = max(abs(logp[i].item() - lp) for i, lp in TOP)
print(f"max |logprob - llama.cpp| over top 5: {worst:.2e}")
assert worst < 5e-3
