"""XTTS adapter for DobStudio. Lazy load XTTS model, synthesize segment WAV."""
from pathlib import Path
from .preflight import validate_model_directory
from .runtime import legacy_torch_load

class Synthesizer:
    def __init__(self, model_path, device, target_language='zh'):
        self.device = device
        self.target_language = target_language or 'zh'
        self.model_path = model_path
        self._model = None
        self.model_path = str(validate_model_directory('xtts', model_path))

    def _load_model(self):
        if self._model is not None:
            return self._model
        import torch
        if self.device == 'cuda' and not torch.cuda.is_available():
            raise RuntimeError('CUDA is not available in the selected Python runtime')
        from TTS.api import TTS
        cfg = Path(self.model_path) / 'config.json'
        with legacy_torch_load():
            tts = TTS(model_path=self.model_path, config_path=str(cfg))
        if self.device == 'cuda':
            tts.to('cuda')
        self._model = tts
        return self._model

    def synthesize(self, text, reference, prompt, output, target_language=None):
        tts = self._load_model()
        lang = (target_language or self.target_language or 'en').lower()
        if lang.startswith('zh'):
            lang = 'zh-cn'
        tts.tts_to_file(
            text=text,
            speaker_wav=str(reference),
            language=lang,
            file_path=str(output)
        )
