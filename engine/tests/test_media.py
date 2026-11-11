import sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import json
import math
import os
from pathlib import Path
import struct
import tempfile
import unittest
import wave
from unittest.mock import patch
from dobstudio_engine.worker import command, render

BIN = os.environ.get('DOBSTUDIO_TEST_MEDIA_BIN')

def wav(path, seconds):
    with wave.open(str(path),'wb') as f:
        f.setnchannels(1);f.setsampwidth(2);f.setframerate(24000)
        f.writeframes(b''.join(struct.pack('<h',int(1200*math.sin(2*math.pi*440*i/24000))) for i in range(round(seconds*24000))))

@unittest.skipUnless(BIN,'Set DOBSTUDIO_TEST_MEDIA_BIN to a folder with ffmpeg and ffprobe')
class MediaTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name)
        suffix='.exe' if os.name=='nt' else ''
        self.ffmpeg=str(Path(BIN)/('ffmpeg'+suffix));self.ffprobe=str(Path(BIN)/('ffprobe'+suffix))
        self.video=self.root/'source.mp4';self.ref=self.root/'ref.wav'
        command([self.ffmpeg,'-v','error','-y','-f','lavfi','-i','color=c=black:s=320x180:r=25:d=2','-f','lavfi','-i','sine=frequency=220:duration=2','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac',self.video]);wav(self.ref,1)
        self.data=dict(version=1,mediaPath=str(self.video),outputDir=str(self.root/'out'),referencePath=str(self.ref),referenceText='hello',referenceLanguage='en',targetLanguage='zh',modelPath=str(self.root/'model'),device='cpu',ffmpeg=self.ffmpeg,ffprobe=self.ffprobe,cues=[dict(index=1,startMs=250,endMs=1250,text='hello',translation='你好')])
    def test_real_ffmpeg_exports_video_with_new_audio_and_unchanged_source(self):
        original=self.video.read_bytes();prompts=[]
        class FakeSynth:
            def __init__(self,*args):pass
            def synthesize(self,text,reference,prompt,output):prompts.append(prompt);wav(output,0.7)
        with patch('dobstudio_engine.cosyvoice_adapter.Synthesizer',FakeSynth): result=render(self.data,lambda e:None)
        self.assertEqual(prompts,['']);self.assertEqual(original,self.video.read_bytes())
        info=json.loads(command([self.ffprobe,'-v','error','-show_streams','-show_format','-of','json',result['videoPath']]))
        self.assertEqual({s['codec_type'] for s in info['streams']},{'video','audio'})
        self.assertAlmostEqual(float(info['format']['duration']),2,delta=0.1)
        with wave.open(result['audioPath'],'rb') as f:
            self.assertEqual(f.getnframes(),48000);self.assertEqual(f.readframes(6000),b'\0'*12000)
    def test_overlong_speech_fails_instead_of_truncating_words(self):
        class FakeSynth:
            def __init__(self,*args):pass
            def synthesize(self,text,reference,prompt,output):wav(output,1.8)
        with patch('dobstudio_engine.cosyvoice_adapter.Synthesizer',FakeSynth):
            with self.assertRaisesRegex(ValueError,'Shorten'):render(self.data,lambda e:None)
        self.assertFalse((self.root/'out/dubbed.mp4').exists())
    def test_long_reference_is_rejected_before_model_load(self):
        wav(self.ref,30)
        with patch('dobstudio_engine.cosyvoice_adapter.Synthesizer') as model:
            with self.assertRaisesRegex(ValueError,'complete'):render(self.data,lambda e:None)
            model.assert_not_called()
    def test_xtts_adapter_selection(self):
        prompts = []
        class FakeXttsSynth:
            def __init__(self, model_path, device, target_language="zh"):
                self.target_language = target_language
            def synthesize(self, text, reference, prompt, output, **kwargs):
                prompts.append((text, prompt))
                wav(output, 0.7)
        data = dict(self.data, engine='xtts', xttsModelPath=str(self.root / 'xtts-model'))
        with patch('dobstudio_engine.xtts_adapter.Synthesizer', FakeXttsSynth):
            result = render(data, lambda e: None)
        self.assertEqual(prompts, [('你好', '')])
        self.assertTrue(Path(result['videoPath']).exists())
    def test_separate_bgm_with_ducking(self):
        calls = []
        real_command = command
        def demucs_stub(args, **kwargs):
            if '-m' in args and 'demucs' in args:
                calls.append([str(a) for a in args])
                stem = self.root / 'out/demucs_temp/htdemucs/separation_input/no_vocals.wav'
                stem.parent.mkdir(parents=True, exist_ok=True)
                wav(stem, 2)
                return ''
            return real_command(args, **kwargs)
        class FakeSynth:
            def __init__(self, *args, **kwargs): pass
            def synthesize(self, text, reference, prompt, output, **kwargs): wav(output, 0.7)
        data = dict(self.data, separateBgm=True, ducking=True, bgmVolume=0.4)
        with patch('importlib.util.find_spec', return_value=object()), patch('dobstudio_engine.worker.command', side_effect=demucs_stub), patch('dobstudio_engine.cosyvoice_adapter.Synthesizer', FakeSynth):
            result = render(data, lambda e: None)
        self.assertEqual(result['backgroundAudio'], 'included')
        for name in ('videoPath','videoPathWithBgm','audioPathWithBgm','bgmPath'):
            self.assertTrue(Path(result[name]).exists())
        self.assertEqual(calls[0][calls[0].index('-d')+1], 'cpu')
        self.assertTrue(calls[0][-1].endswith('separation_input.wav'))
        with wave.open(result['bgmPath'],'rb') as f:
            self.assertNotEqual(f.readframes(f.getnframes()).strip(b'\0'), b'')

    def test_missing_demucs_fails_without_loading_model_or_using_source(self):
        with patch('importlib.util.find_spec', return_value=None), patch('dobstudio_engine.cosyvoice_adapter.Synthesizer') as synth:
            with self.assertRaisesRegex(RuntimeError, 'requires Demucs'):
                render(dict(self.data, separateBgm=True), lambda e: None)
            synth.assert_not_called()
        self.assertFalse((self.root/'out/result.json').exists())
        self.assertFalse((self.root/'out/instruments.wav').exists())

    def test_failed_demucs_never_falls_back_to_original_audio(self):
        real_command = command
        def fail_demucs(args, **kwargs):
            if '-m' in args and 'demucs' in args: raise RuntimeError('simulated CUDA OOM')
            return real_command(args, **kwargs)
        with patch('importlib.util.find_spec', return_value=object()), patch('dobstudio_engine.worker.command', side_effect=fail_demucs):
            with self.assertRaisesRegex(RuntimeError, 'Background separation failed.*CUDA OOM'):
                render(dict(self.data, separateBgm=True), lambda e: None)
        self.assertFalse((self.root/'out/instruments.wav').exists())
        self.assertFalse((self.root/'out/result.json').exists())

    def test_missing_demucs_stem_does_not_report_success(self):
        real_command = command
        def no_stem(args, **kwargs):
            return '' if '-m' in args and 'demucs' in args else real_command(args, **kwargs)
        with patch('importlib.util.find_spec', return_value=object()), patch('dobstudio_engine.worker.command', side_effect=no_stem):
            with self.assertRaisesRegex(RuntimeError, 'no accompaniment stem'):
                render(dict(self.data, separateBgm=True), lambda e: None)
        self.assertFalse((self.root/'out/result.json').exists())
