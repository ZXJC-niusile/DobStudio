"""Shared compatibility for legacy checkpoint loaders."""
from contextlib import contextmanager
import threading

_torch_load_lock = threading.RLock()


@contextmanager
def legacy_torch_load():
    """Serialize legacy patches across engines and restore on every exit.

    Explicit weights_only arguments are preserved. This is still a process-wide
    compatibility patch; it must only be used for trusted local checkpoints.
    """
    import torch
    with _torch_load_lock:
        original = torch.load

        def load(*args, **kwargs):
            kwargs.setdefault('weights_only', False)
            return original(*args, **kwargs)

        torch.load = load
        try:
            yield
        finally:
            torch.load = original
