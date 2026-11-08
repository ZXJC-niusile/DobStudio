"""Behavioral coverage for shared state and the reusable pipeline boundary."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import nullcontext
from dataclasses import replace
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import types
import unittest
from unittest import mock

import test_omnidub_regressions  # installs optional ML stubs for unit tests
from youdub import pipeline, utils
from youdub import step020_whisperx as wx, step030_translation as tr, step042_tts_xtts as xt
from youdub.config import PipelineConfig, TranslationConfig


class ConsolidationTests(unittest.TestCase):
    def test_cross_engine_checkpoint_patches_serialize_and_restore(self):
        entered = threading.Event()
        release = threading.Event()
        waiting = threading.Event()
        second_entered = threading.Event()
        original = mock.Mock(return_value='loaded')

        def first():
            with xt.legacy_torch_load():
                entered.set()
                self.assertTrue(release.wait(5))
                wx.torch.load('first', weights_only=True)

        def second():
            self.assertTrue(entered.wait(5))
            waiting.set()
            with wx.legacy_torch_load():
                second_entered.set()
                wx.torch.load('second')
                raise ValueError('failed load')

        with mock.patch.object(wx.torch, 'load', original), ThreadPoolExecutor(2) as pool:
            a, b = pool.submit(first), pool.submit(second)
            try:
                self.assertTrue(waiting.wait(5))
                self.assertFalse(second_entered.wait(0.05))
            finally:
                release.set()
            a.result(timeout=5)
            with self.assertRaisesRegex(ValueError, 'failed load'):
                b.result(timeout=5)
            self.assertIs(wx.torch.load, original)
            original.assert_any_call('first', weights_only=True)
            original.assert_any_call('second', weights_only=False)

    def test_xtts_cache_path_identity_singleflight_and_cpu_reuse(self):
        cpu = mock.Mock()
        cpu.tts.return_value = [0.0] * 240
        gpu = mock.Mock()
        gpu.tts.side_effect = RuntimeError('CUDA error')
        other = mock.Mock()
        with tempfile.TemporaryDirectory() as folder, \
             mock.patch.dict(xt._models, clear=True), \
             mock.patch.object(xt, '_instantiate_xtts', side_effect=[cpu, other, gpu]) as constructor:
            a, b = os.path.join(folder, 'A'), os.path.join(folder, 'B')
            with ThreadPoolExecutor(4) as pool:
                models = list(pool.map(lambda _: xt.load_model(a, 'cpu'), range(4)))
            self.assertTrue(all(model is cpu for model in models))
            self.assertIs(xt.load_model(b, 'cpu'), other)
            xt.tts('hello', os.path.join(folder, 'out.wav'), 'reference.wav', model_name=a, device='cuda:0')
            self.assertEqual(constructor.call_count, 3)
            cpu.tts.assert_called_once()

    def test_task_config_and_actual_request_share_snapshot(self):
        with mock.patch.dict(os.environ, {'MODEL_NAME': 'first', 'TRANSLATION_BATCH_SIZE': '3',
                                         'OPENAI_API_KEY': 'private-test-key'}):
            cfg = PipelineConfig()
        client = mock.Mock()
        client.chat.completions.create.return_value = types.SimpleNamespace(choices=[
            types.SimpleNamespace(message=types.SimpleNamespace(content='1. Hello'))])
        before = pipeline._translation_spec('.', cfg)[1]
        with mock.patch.dict(os.environ, {'MODEL_NAME': 'second', 'TRANSLATION_BATCH_SIZE': '99'}):
            self.assertEqual(pipeline._translation_spec('.', cfg)[1], before)
            result = tr._translate_batch(client, 'translate', [], ['你好'], 'English', settings=cfg.translation)
            self.assertEqual(result, ['Hello'])
            self.assertEqual(client.chat.completions.create.call_args.kwargs['model'], 'first')
            self.assertNotEqual(PipelineConfig().translation, cfg.translation)
        self.assertNotIn('private-test-key', repr(cfg))
        self.assertNotIn('private-test-key', json.dumps(before))

    def test_output_affecting_config_changes_invalidate_cache(self):
        cfg = PipelineConfig()
        for field, value in [('whisper_min_speakers', 2), ('whisper_max_speakers', 4),
                             ('whisper_align_fallback', 'ja'), ('whisper_diarization_model', 'model-B')]:
            self.assertNotEqual(pipeline._transcript_spec('.', cfg)[1],
                                pipeline._transcript_spec('.', replace(cfg, **{field: value}))[1])
        self.assertNotEqual(pipeline._video_spec('.', cfg)[1],
                            pipeline._video_spec('.', replace(cfg, subtitle_font='new-font'))[1])

    def test_existing_stage_output_does_not_override_new_translation(self):
        with tempfile.TemporaryDirectory() as folder:
            for name, value in [('transcript.json', [{'start': 0, 'end': 1, 'text': '你好'}]),
                                ('translation.json', [{'translation': 'old'}]),
                                ('summary.json', {'title': 'stale', 'language': 'English'})]:
                Path(folder, name).write_text(json.dumps(value), encoding='utf-8')
            settings = TranslationConfig(model='new-model')
            with mock.patch.object(tr, 'summarize', return_value={'title': 'new', 'summary': 'new'}) as summary, \
                 mock.patch.object(tr, '_translate', return_value=['Hello']) as translate:
                tr.translate(folder, 'English', settings=settings)
                self.assertEqual(summary.call_args.kwargs['settings'], settings)
                self.assertEqual(translate.call_args.kwargs['settings'], settings)
            self.assertEqual(json.loads(Path(folder, 'translation.json').read_text(encoding='utf-8'))[0]['translation'], 'Hello')

    def test_cached_prepared_task_never_loads_stage_models(self):
        with tempfile.TemporaryDirectory() as folder:
            Path(folder, 'download.mp4').write_bytes(b'input')
            Path(folder, 'video.mp4').write_bytes(b'output')
            with mock.patch.object(utils, 'reserved_cuda_devices', return_value=nullcontext(['cpu'])), \
                 mock.patch.object(utils, 'should_skip_step', return_value=True), \
                 mock.patch.object(pipeline, 'has_speaker_wavs', return_value=True), \
                 mock.patch.object(pipeline, '_execute_stage', side_effect=AssertionError('unexpected stage load')):
                result = pipeline.run_tasks([folder], PipelineConfig(generate_metadata=False), source='folder')
            self.assertTrue(result.tasks[0].success)
            self.assertEqual(result.tasks[0].artifacts['video.mp4'], os.path.join(folder, 'video.mp4'))
            self.assertNotIn('video.txt', result.tasks[0].artifacts)

    def test_shared_scheduler_preserves_order_and_failure_stage(self):
        with tempfile.TemporaryDirectory() as root:
            folders = [os.path.join(root, name) for name in ('ok', 'bad')]
            for folder in folders:
                os.makedirs(folder)
                Path(folder, 'download.mp4').write_bytes(b'input')

            def run(folder, cfg):
                if folder.endswith('bad'):
                    raise pipeline.StageError('tts', RuntimeError('model failed'))
                Path(folder, 'video.mp4').write_bytes(b'result')

            with mock.patch.object(utils, 'reserved_cuda_devices', return_value=nullcontext(['cpu', 'cpu'])), \
                 mock.patch.object(pipeline, '_run_pipeline', side_effect=run) as execute:
                result = pipeline.run_tasks(folders, PipelineConfig(max_workers=2, max_retries=2), source='folder')
            self.assertEqual([r.success for r in result.tasks], [True, False])
            self.assertEqual(result.tasks[1].error_stage, 'tts')
            self.assertEqual(result.tasks[1].error, 'model failed')
            self.assertEqual(execute.call_count, 3)
            self.assertEqual(result.summary(), 'Success: 1  Fail: 1')

    def test_dependency_import_failure_reports_stage(self):
        with mock.patch.object(pipeline.importlib, 'import_module', side_effect=ImportError('missing engine')):
            with self.assertRaises(pipeline.StageError) as caught:
                pipeline._execute_stage('tts', 'step040_tts.generate_wavs', '.')
        self.assertEqual(caught.exception.stage, 'tts')

    def test_core_import_does_not_import_ml_ui_or_load_dotenv(self):
        code = '''
import importlib.abc, sys, types
sys.modules['loguru'] = types.SimpleNamespace(logger=None)
class Block(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, *args):
        if fullname.split('.')[0] in {'torch', 'numpy', 'demucs', 'whisperx', 'gradio', 'dotenv', 'openai', 'librosa'}:
            raise AssertionError('Unexpected heavy import: ' + fullname)
sys.meta_path.insert(0, Block())
from youdub.pipeline import PipelineConfig, run_tasks, BatchResult
assert PipelineConfig().tts_engine == 'cosyvoice'
'''
        result = subprocess.run([sys.executable, '-c', code], cwd=Path(__file__).resolve().parents[1], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_explicit_missing_hf_token_does_not_read_new_environment(self):
        with mock.patch.object(wx, '_supports_diarization_pipeline', return_value=True), \
             mock.patch.object(wx, '_get_hf_token', side_effect=AssertionError('environment reread')):
            self.assertIsNone(wx.load_diarize_model('cpu', model_name=None, hf_token=None))


if __name__ == '__main__':
    unittest.main()
