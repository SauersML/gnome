"""Quantizes a F32 bee GGUF to Q8_0, the format the Worker engine reads at a quarter of the size.

Every matrix whose rows are whole 32-weight blocks becomes Q8_0, the token embedding and output
included; norms stay F32. The bytes match llama-quantize's Q8_0 for the same tensors.
Usage: python quantize.py in.gguf out.gguf
"""
import sys

from gguf_io import QK8_0, Gguf

LLAMA_FTYPE_MOSTLY_Q8_0 = 7

if __name__ == "__main__":
    src, dst = sys.argv[1:3]
    g = Gguf(src)
    tensors = {name: g.tensor(name) for name in g.tensors}
    q8 = frozenset(name for name, t in tensors.items() if t.ndim == 2 and t.shape[1] % QK8_0 == 0)
    g.write_new(dst, {"general.file_type": LLAMA_FTYPE_MOSTLY_Q8_0}, tensors, q8)
    print(f"{dst}: {len(q8)} of {len(tensors)} tensors in Q8_0")
