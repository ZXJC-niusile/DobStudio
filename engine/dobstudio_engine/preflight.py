"""Model layout and dependency checks without importing torch or loading weights."""
import importlib.util
import json
from pathlib import Path


def validate_model_directory(engine, model_path):
    folder = Path(model_path or '')
    if not model_path or not folder.is_absolute() or not folder.is_dir():
        raise ValueError(f'Choose an absolute local {engine} model directory')
    if engine == 'xtts':
        required = ('config.json', 'model.pth', 'vocab.json')
        missing = [name for name in required if not (folder / name).is_file()]
        if missing:
            raise ValueError('XTTS model is missing: ' + ', '.join(missing))
        config = json.loads((folder / 'config.json').read_text(encoding='utf-8'))
        if config.get('model') != 'xtts':
            raise ValueError('The selected directory is not an XTTS model')
    elif engine == 'cosyvoice':
        if not any((folder / name).is_file() for name in ('cosyvoice.yaml', 'cosyvoice2.yaml', 'cosyvoice3.yaml')):
            raise ValueError('The selected directory is not a CosyVoice model')
    else:
        raise ValueError('Unknown TTS engine')
    return folder


def check_runtime(engine, model_path, separate_bgm=False):
    validate_model_directory(engine, model_path)
    modules = ['torch', 'torchaudio']
    modules += ['TTS'] if engine == 'xtts' else ['soundfile', 'hyperpyyaml', 'modelscope', 'onnxruntime', 'matcha']
    if separate_bgm:
        modules.append('demucs')
    missing = [name for name in modules if importlib.util.find_spec(name) is None]
    if missing:
        requirements = 'requirements-xtts.txt' if engine == 'xtts' else 'requirements.txt'
        if 'demucs' in missing:
            requirements += ' and requirements-bgm.txt'
        raise RuntimeError('Selected Python is missing: ' + ', '.join(missing) +
                           '. Install engine/' + requirements + ' using this interpreter; install matching torch/torchaudio separately.')
    return {'version': 1, 'type': 'ready', 'engine': engine}
