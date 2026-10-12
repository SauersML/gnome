"""Read F32 llama GGUF tensors as numpy arrays and write a copy with new tensor values.

Writing copies the original file byte for byte and replaces only tensor data, so the
metadata, tokenizer and layout stay exactly as llama.cpp and the Worker engine expect.
"""
import struct

import numpy as np

_SCALARS = {0: "B", 1: "b", 2: "H", 3: "h", 4: "I", 5: "i", 6: "f", 7: "?", 10: "Q", 11: "q", 12: "d"}


class Gguf:
    def __init__(self, path: str):
        self.path = path
        self.data = open(path, "rb").read()
        self.pos = 0
        if self._read("4s") != b"GGUF" or self._read("I") != 3:
            raise ValueError(f"{path} is not a version 3 GGUF")
        n_tensors, n_kv = self._read("Q"), self._read("Q")
        self.meta = {}
        for _ in range(n_kv):
            key = self._str()
            self.meta[key] = self._value(self._read("I"))
        infos = []
        for _ in range(n_tensors):
            name = self._str()
            dims = [self._read("Q") for _ in range(self._read("I"))]
            ggml_type, offset = self._read("I"), self._read("Q")
            if ggml_type != 0:
                raise ValueError(f"{name} is not F32")
            infos.append((name, dims, offset))
        align = self.meta.get("general.alignment", 32)
        start = (self.pos + align - 1) // align * align
        # GGUF dims list the fastest-varying axis first; numpy shape is the reverse.
        self.tensors = {name: (start + off, tuple(reversed(dims))) for name, dims, off in infos}

    def _read(self, fmt: str):
        size = struct.calcsize("<" + fmt)
        (value,) = struct.unpack_from("<" + fmt, self.data, self.pos)
        self.pos += size
        return value

    def _str(self) -> str:
        n = self._read("Q")
        s = self.data[self.pos:self.pos + n].decode("utf-8")
        self.pos += n
        return s

    def _value(self, t: int):
        if t == 8:
            return self._str()
        if t == 9:
            et, n = self._read("I"), self._read("Q")
            return [self._value(et) for _ in range(n)]
        return self._read(_SCALARS[t])

    def tensor(self, name: str) -> np.ndarray:
        offset, shape = self.tensors[name]
        return np.frombuffer(self.data, dtype="<f4", count=int(np.prod(shape)), offset=offset).reshape(shape).copy()

    def write(self, path: str, tensors: dict[str, np.ndarray]) -> None:
        out = bytearray(self.data)
        for name, value in tensors.items():
            offset, shape = self.tensors[name]
            arr = np.ascontiguousarray(value, dtype="<f4")
            if arr.shape != shape:
                raise ValueError(f"{name}: shape {arr.shape} != {shape}")
            out[offset:offset + arr.nbytes] = arr.tobytes()
        with open(path, "wb") as f:
            f.write(out)
