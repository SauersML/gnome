"""The BeeLLM llama forward pass in PyTorch, matching src/server/bee.ts and llama.cpp."""
import math

import numpy as np
import torch
import torch.nn.functional as F
from torch import nn

from gguf_io import Gguf


class Bee(nn.Module):
    def __init__(self, gguf: Gguf):
        super().__init__()
        m = gguf.meta
        self.d = m["llama.embedding_length"]
        self.n_layer = m["llama.block_count"]
        self.n_head = m["llama.attention.head_count"]
        self.eps = m["llama.attention.layer_norm_rms_epsilon"]
        base = m.get("llama.rope.freq_base", 10000.0)
        self.hd = self.d // self.n_head
        self.names = [n for n in gguf.tensors]
        self.w = nn.ParameterDict({n.replace(".", "__"): nn.Parameter(torch.from_numpy(gguf.tensor(n))) for n in self.names})
        inv = base ** (-np.arange(0, self.hd, 2) / self.hd)
        self.register_buffer("inv_freq", torch.tensor(inv, dtype=torch.float32), persistent=False)

    def p(self, name: str) -> torch.Tensor:
        return self.w[name.replace(".", "__")]

    def rms(self, x: torch.Tensor, weight: torch.Tensor) -> torch.Tensor:
        return x * torch.rsqrt(x.pow(2).mean(-1, keepdim=True) + self.eps) * weight

    def rope(self, x: torch.Tensor) -> torch.Tensor:
        # ggml "normal" rope: adjacent pairs (2i, 2i+1) rotate by pos * base^(-2i/hd).
        T = x.shape[1]
        ang = torch.arange(T, device=x.device, dtype=torch.float32)[:, None] * self.inv_freq[None, :]
        cos, sin = ang.cos()[None, :, None, :], ang.sin()[None, :, None, :]
        x0, x1 = x[..., 0::2], x[..., 1::2]
        return torch.stack((x0 * cos - x1 * sin, x0 * sin + x1 * cos), dim=-1).flatten(-2)

    def forward(self, ids: torch.Tensor) -> torch.Tensor:
        B, T = ids.shape
        x = F.embedding(ids, self.p("token_embd.weight"))
        for l in range(self.n_layer):
            b = f"blk.{l}."
            h = self.rms(x, self.p(b + "attn_norm.weight"))
            q = (h @ self.p(b + "attn_q.weight").T).view(B, T, self.n_head, self.hd)
            k = (h @ self.p(b + "attn_k.weight").T).view(B, T, self.n_head, self.hd)
            v = (h @ self.p(b + "attn_v.weight").T).view(B, T, self.n_head, self.hd)
            q, k = self.rope(q), self.rope(k)
            a = F.scaled_dot_product_attention(q.transpose(1, 2), k.transpose(1, 2), v.transpose(1, 2), is_causal=True, scale=1 / math.sqrt(self.hd))
            x = x + a.transpose(1, 2).reshape(B, T, self.d) @ self.p(b + "attn_output.weight").T
            h = self.rms(x, self.p(b + "ffn_norm.weight"))
            g = F.silu(h @ self.p(b + "ffn_gate.weight").T) * (h @ self.p(b + "ffn_up.weight").T)
            x = x + g @ self.p(b + "ffn_down.weight").T
        x = self.rms(x, self.p("output_norm.weight"))
        return x @ self.p("output.weight").T

    def tensors(self) -> dict[str, np.ndarray]:
        return {n: self.p(n).detach().float().cpu().numpy() for n in self.names}
