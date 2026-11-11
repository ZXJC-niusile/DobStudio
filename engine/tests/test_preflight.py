import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import json
import os
import subprocess
import tempfile
import unittest
from unittest.mock import patch
from contextlib import nullcontext
from dobstudio_engine.preflight import check_runtime, validate_model_directory
from dobstudio_engine.protocol import validate_manifest
from dobstudio_engine.xtts_adapter import Synthesizer

class PreflightTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root/'config.json').write_text('{"model":"xtts"}', encoding='utf-8')
        (self.root/'model.pth').write_bytes(b'fixture')
        (self.root/'vocab.json').write_text('{}', encoding='utf-8')

    def test_missing_xtts_runtime_has_install_instruction(self):
        with patch('importlib.util.find_spec', side_effect=lambda name: None if name=='TTS' else object()):
            with self.assertRaisesRegex(RuntimeError, 'TTS.*requirements-xtts.txt'):
                check_runtime('xtts', str(self.root))

    def test_missing_demucs_reports_optional_install(self):
        with patch('importlib.util.find_spec', side_effect=lambda name: None if name=='demucs' else object()):
            with self.assertRaisesRegex(RuntimeError, 'demucs.*requirements-bgm.txt'):
                check_runtime('xtts', str(self.root), True)

    def test_runtime_checks_do_not_import_models(self):
        with patch('importlib.util.find_spec', return_value=object()):
            self.assertEqual(check_runtime('xtts', str(self.root))['type'], 'ready')
        self.assertNotIn('TTS', sys.modules)
        self.assertNotIn('torch', sys.modules)

    def test_wrong_model_directory_and_file_are_rejected(self):
        with self.assertRaisesRegex(ValueError, 'directory'):
            Synthesizer(str(self.root/'model.pth'), 'cpu')
        with self.assertRaisesRegex(ValueError, 'directory'):
            Synthesizer('', 'cpu')
        (self.root/'config.json').write_text('{"model":"cosyvoice"}', encoding='utf-8')
        with self.assertRaisesRegex(ValueError, 'not an XTTS'):
            Synthesizer(str(self.root), 'cpu')

    def test_loader_uses_only_local_model_and_never_downloads(self):
        import types
        calls=[]
        class FakeTTS:
            def __init__(self,*args,**kwargs): calls.append((args,kwargs))
        fake_api=types.ModuleType('TTS.api'); fake_api.TTS=FakeTTS
        with patch.dict(sys.modules, {'torch':types.ModuleType('torch'),'TTS':types.ModuleType('TTS'),'TTS.api':fake_api}), patch('dobstudio_engine.xtts_adapter.legacy_torch_load', nullcontext):
            Synthesizer(str(self.root),'cpu')._load_model()
        self.assertEqual(calls,[((),{'model_path':str(self.root),'config_path':str(self.root/'config.json')})])

    def test_preflight_error_protocol_needs_no_manifest(self):
        env={**os.environ,'PYTHONPATH':str(Path(__file__).resolve().parents[1]),'PYTHONDONTWRITEBYTECODE':'1'}
        result=subprocess.run([sys.executable,'-m','dobstudio_engine','--preflight','--engine','xtts','--model-path',str(self.root/'missing')],env=env,capture_output=True,text=True)
        self.assertEqual(result.returncode,1)
        self.assertEqual(json.loads(result.stdout)['type'],'error')

    def test_xtts_manifest_requires_its_own_model_path(self):
        data={'version':1,'engine':'xtts','modelPath':str(self.root)}
        # Earlier missing paths fail too; a complete manifest isolates the XTTS field.
        data.update({key:str(self.root/key) for key in ('mediaPath','outputDir','referencePath','ffmpeg','ffprobe')})
        data.update(device='cpu',targetLanguage='en',referenceLanguage='en',referenceText='',cues=[dict(startMs=0,endMs=1000,translation='hello')])
        with self.assertRaisesRegex(ValueError,'xttsModelPath'):
            validate_manifest(data)
