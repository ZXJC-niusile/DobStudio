"""Require the CosyVoice native text frontend."""


def require_native_frontend(model):
    backend = model.frontend.text_frontend
    if backend not in {'ttsfrd', 'wetext'}:
        raise RuntimeError(
            'CosyVoice requires its native ttsfrd or wetext text frontend. '
            'Install engine/requirements.txt.'
        )
    return backend
