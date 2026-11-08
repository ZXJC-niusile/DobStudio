"""Real dependency smoke check: no stubs, API requests or speech weights."""
import argparse
import importlib
from pathlib import Path
import sys


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--xtts', action='store_true')
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    sys.path.insert(0, str(root))
    # The engine adapter owns vendor path setup, just as it does at runtime.
    importlib.import_module('youdub.step043_tts_cosyvoice')
    modules = ['gradio', 'yt_dlp', 'dotenv', 'PIL', 'demucs.api', 'whisperx',
               'audiostretchy', 'openai', 'matcha.models.components.flow_matching',
               'cosyvoice.cli.cosyvoice']
    if args.xtts:
        modules.append('TTS.api')
    for module in modules:
        importlib.import_module(module)
    from wetext import Normalizer
    assert '零点零五' in Normalizer(lang='zh', operator='tn').normalize('误差0.05')
    print('Runtime imports and wetext passed; speech weights and synthesis were not tested.')


if __name__ == '__main__':
    main()
