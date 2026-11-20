"""Checkpoint loading for the single-task inference worker."""
from contextlib import contextmanager


@contextmanager
def legacy_torch_load():
    import torch
    original = torch.load

    def load(*args, **kwargs):
        kwargs.setdefault("weights_only", False)
        return original(*args, **kwargs)

    torch.load = load
    try:
        yield
    finally:
        torch.load = original
