"""One model per isolated task. Native normalization owns all spoken text."""
from pathlib import Path
import sys
from .text_frontend import require_native_frontend
from .runtime import legacy_torch_load

class Synthesizer:
    def __init__(self, model_path, device):
        vendor=Path(__file__).resolve().parents[1]/'vendor'/'CosyVoice'
        sys.path.insert(0,str(vendor))
        matcha=vendor/'third_party'/'Matcha-TTS'
        if (matcha/'matcha'/'models').exists(): sys.path.insert(0,str(matcha))
        import torch
        from cosyvoice.cli.cosyvoice import CosyVoice, CosyVoice2, CosyVoice3
        folder=Path(model_path)
        if not folder.is_dir(): raise ValueError('Local CosyVoice model directory does not exist')
        model_class = CosyVoice3 if (folder/'cosyvoice3.yaml').exists() else CosyVoice2 if (folder/'cosyvoice2.yaml').exists() else CosyVoice
        if device=='cuda' and not torch.cuda.is_available(): raise RuntimeError('CUDA is not available in the selected Python runtime')
        # CUDA visibility is fixed before importing torch by worker.render.
        with legacy_torch_load(): self.model=model_class(str(folder))
        require_native_frontend(self.model)
        self.torch=torch

    def synthesize(self, text, reference, prompt, output):
        import soundfile
        if prompt:
            chunks=self.model.inference_zero_shot(text,prompt,reference,text_frontend=True)
        else:
            chunks=self.model.inference_cross_lingual(text,reference,text_frontend=True)
        speech=[part['tts_speech'].cpu() for part in chunks if 'tts_speech' in part]
        if not speech: raise RuntimeError('CosyVoice returned no speech')
        soundfile.write(str(output),self.torch.cat(speech,dim=-1).squeeze(0).numpy(),self.model.sample_rate)
