import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import json
import os
import subprocess
import tempfile
import unittest
from dobstudio_engine.protocol import validate_manifest

os.environ["PYTHONPATH"] = str(Path(__file__).resolve().parents[1])

class ProtocolTests(unittest.TestCase):
    def manifest(self, root):
        return dict(
            version=1,
            mediaPath=str(root / 'video.mp4'),
            outputDir=str(root / 'out'),
            referencePath=str(root / 'ref.wav'),
            modelPath=str(root / 'model'),
            ffmpeg=str(root / 'ffmpeg'),
            ffprobe=str(root / 'ffprobe'),
            device='cpu',
            targetLanguage='zh',
            referenceLanguage='en',
            referenceText='',
            cues=[dict(index=1, startMs=0, endMs=1000, text='hello', translation='你好')]
        )

    def test_validation_does_not_import_model_packages(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            path = root / 'manifest.json'
            path.write_text(json.dumps(self.manifest(root)), encoding='utf-8')
            code = (
                "import sys,runpy;sys.argv=['worker','--check','--manifest',sys.argv[1]];\n"
                "try: runpy.run_module('dobstudio_engine',run_name='__main__')\n"
                "except SystemExit as e: assert e.code==0\n"
                "assert not any(n in sys.modules for n in ['torch','demucs','cosyvoice','torchaudio','TTS'])"
            )
            result = subprocess.run([sys.executable, '-c', code, str(path)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout)['type'], 'validated')

    def test_invalid_timing_and_missing_translation(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            for value in [float('nan'), -1, True]:
                data = self.manifest(root)
                data['cues'][0]['startMs'] = value
                with self.assertRaises(ValueError):
                    validate_manifest(data)
            data = self.manifest(root)
            data['cues'][0]['translation'] = ''
            with self.assertRaises(ValueError):
                validate_manifest(data)

    def test_protocol_error_is_structured(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'bad.json'
            path.write_text('{"version":99}', encoding='utf-8')
            result = subprocess.run(
                [sys.executable, '-m', 'dobstudio_engine', '--check', '--manifest', str(path)],
                capture_output=True,
                text=True
            )
            self.assertEqual(result.returncode, 1)
            self.assertEqual(json.loads(result.stdout)['type'], 'error')

    def test_modular_configuration_fields_and_defaults(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            data = self.manifest(root)
            validated = validate_manifest(data)
            self.assertEqual(validated['engine'], 'cosyvoice')
            self.assertFalse(validated['separateBgm'])
            self.assertTrue(validated['ducking'])
            self.assertAlmostEqual(validated['bgmVolume'], 0.3)

            # Explicit engine choices
            data_xtts = self.manifest(root)
            data_xtts['engine'] = 'xtts'
            data_xtts['xttsModelPath'] = str(root / 'xtts-model')
            data_xtts['separateBgm'] = True
            data_xtts['ducking'] = False
            data_xtts['bgmVolume'] = 0.55
            validated_xtts = validate_manifest(data_xtts)
            self.assertEqual(validated_xtts['engine'], 'xtts')
            self.assertTrue(validated_xtts['separateBgm'])
            self.assertFalse(validated_xtts['ducking'])
            self.assertAlmostEqual(validated_xtts['bgmVolume'], 0.55)
            self.assertEqual(validated_xtts['xttsModelPath'], str(root / 'xtts-model'))

            # Invalid values
            invalid_cases = [
                {'engine': 'invalid_tts'},
                {'separateBgm': 'not-a-bool'},
                {'ducking': 123},
                {'bgmVolume': -0.1},
                {'bgmVolume': 1.5},
                {'bgmVolume': 'loud'},
                {'xttsModelPath': 456},
            ]
            for patch_data in invalid_cases:
                bad_data = self.manifest(root)
                bad_data.update(patch_data)
                with self.assertRaises(ValueError, msg=f"Failed to reject {patch_data}"):
                    validate_manifest(bad_data)

if __name__ == '__main__':
    unittest.main()
