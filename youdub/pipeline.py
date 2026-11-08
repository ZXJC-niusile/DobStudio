# -*- coding: utf-8 -*-
"""
OmniDub — Production Pipeline

Structured core: run_tasks(inputs, config, source=...).
The process_online_video/process_local_video functions adapt results for the UI.

Each step is guarded by a parameter- and upstream-input-aware fingerprint check:
if the expected artefacts already exist on disk and match both current parameters
and upstream artefact digests, the step is skipped; any upstream change cascades
automatically through all downstream steps.
"""

from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, replace
import hashlib
import importlib
import json
import os
import re
import shutil
import threading
import time

from loguru import logger

from .text_frontend import normalization_identity

from .media import remux_to_mp4
from .config import PipelineConfig, validate_engine_and_language
from .speaker_reference import reference_fingerprint, has_speaker_wavs

_LOCAL_PREP_LOCK = threading.Lock()


# ── helpers ───────────────────────────────────────────────────────────
def _sanitize_folder_name(name: str) -> str:
    cleaned = re.sub(r'[\\/:*?"<>|]', "_", name).strip()
    return cleaned or f"local_video_{int(time.time())}"


def _file_input_token(path: str) -> str:
    """Compute a deterministic content/stat token for an upstream artefact.
    Small JSON/text files (<= 2 MB) are hashed by content; large media files
    are tracked via (size, mtime_ns) for sub-millisecond checks."""
    if not os.path.isfile(path):
        return 'missing'
    try:
        st = os.stat(path)
        if st.st_size <= 2 * 1024 * 1024:
            h = hashlib.sha256()
            with open(path, 'rb') as f:
                for chunk in iter(lambda: f.read(65536), b''):
                    h.update(chunk)
            return f'sha256:{h.hexdigest()}'
        return f'stat:{st.st_size}:{st.st_mtime_ns}'
    except OSError:
        return 'unreadable'


def _copy_or_remux_to_mp4(src_path: str, target_mp4: str) -> None:
    ext = os.path.splitext(src_path)[1].lower()
    if ext == '.mp4':
        shutil.copy2(src_path, target_mp4)
        return
    logger.info(f"Remuxing non-MP4 local video ({ext or 'unknown'}) -> {target_mp4}")
    remux_to_mp4(src_path, target_mp4)


def _prepare_local_video_folder(local_video_path: str, root_folder: str) -> str:
    """Copy/remux a local file into the standard folder layout without basename collisions or stale reuse."""
    if not local_video_path:
        raise ValueError("Local video path is empty.")
    if not os.path.isfile(local_video_path):
        raise FileNotFoundError(f"Local video not found: {local_video_path}")

    abs_src = os.path.abspath(local_video_path)
    st = os.stat(abs_src)
    src_meta = {
        "abspath": abs_src,
        "size": st.st_size,
        "mtime_ns": st.st_mtime_ns,
    }

    base_name = os.path.splitext(os.path.basename(abs_src))[0]
    sanitized_base = _sanitize_folder_name(base_name)

    with _LOCAL_PREP_LOCK:
        folder = os.path.join(root_folder, sanitized_base)
        marker_path = os.path.join(folder, ".local_source.json")
        info_path = os.path.join(folder, "download.info.json")

        # Disambiguate when another file from a different directory already owns `folder`.
        existing_owner = None
        if os.path.isfile(marker_path):
            try:
                with open(marker_path, "r", encoding="utf-8") as f:
                    existing_owner = json.load(f).get("abspath")
            except Exception:
                existing_owner = None
        elif os.path.isfile(info_path):
            try:
                with open(info_path, "r", encoding="utf-8") as f:
                    raw_url = json.load(f).get("webpage_url")
                if raw_url:
                    existing_owner = os.path.abspath(raw_url)
            except Exception:
                existing_owner = None

        if existing_owner and os.path.normcase(existing_owner) != os.path.normcase(abs_src):
            short_hash = hashlib.sha1(os.path.normcase(abs_src).encode("utf-8")).hexdigest()[:8]
            folder = os.path.join(root_folder, f"{sanitized_base}_{short_hash}")
            marker_path = os.path.join(folder, ".local_source.json")
            info_path = os.path.join(folder, "download.info.json")

        os.makedirs(folder, exist_ok=True)
        target_video = os.path.join(folder, "download.mp4")

        cached_meta = None
        if os.path.isfile(marker_path):
            try:
                with open(marker_path, "r", encoding="utf-8") as f:
                    cached_meta = json.load(f)
            except Exception:
                cached_meta = None

        source_unchanged = (
            os.path.isfile(target_video)
            and os.path.getsize(target_video) > 0
            and cached_meta is not None
            and cached_meta.get("size") == src_meta["size"]
            and cached_meta.get("mtime_ns") == src_meta["mtime_ns"]
        )

        if not source_unchanged:
            same_source = os.path.exists(target_video) and os.path.samefile(abs_src, target_video)
            if os.path.exists(target_video) and not same_source:
                try:
                    os.remove(target_video)
                except OSError:
                    pass
            if not same_source:
                _copy_or_remux_to_mp4(abs_src, target_video)
            with open(marker_path, "w", encoding="utf-8") as f:
                json.dump(src_meta, f, indent=2, ensure_ascii=False)
            logger.info(f"Prepared local video at {target_video}")
        else:
            logger.info(f"Using up-to-date local video: {target_video}")

        if not os.path.exists(info_path) or not source_unchanged:
            info = {
                "title": base_name or "Local Video",
                "uploader": "Local File",
                "description": "Generated from local video file.",
                "upload_date": time.strftime("%Y%m%d"),
                "categories": ["Local"],
                "tags": ["local", "test"],
                "webpage_url": abs_src,
            }
            with open(info_path, "w", encoding="utf-8") as f:
                json.dump(info, f, indent=2, ensure_ascii=False)
            logger.info(f"Saved local metadata: {info_path}")

    return folder


# ── step specs (params + upstream inputs + outputs) ───────────────────
def _cache_audio(folder: str) -> bool:
    audio_path = os.path.join(folder, "audio.wav")
    return os.path.isfile(audio_path) and os.path.getsize(audio_path) > 1024


def _vocals_spec(folder: str, cfg: PipelineConfig) -> tuple[str, dict, list[str]]:
    return (
        'step010_demucs',
        {
            'demucs_model': cfg.demucs_model,
            'demucs_shifts': cfg.demucs_shifts,
            'upstream_video': _file_input_token(os.path.join(folder, 'download.mp4')),
        },
        [
            os.path.join(folder, 'audio_vocals.wav'),
            os.path.join(folder, 'audio_instruments.wav'),
        ],
    )


def _transcript_spec(folder: str, cfg: PipelineConfig) -> tuple[str, dict, list[str]]:
    return (
        'step020_whisperx',
        {
            'whisper_model': cfg.whisper_model,
            'source_language': cfg.source_language,
            'whisper_diarization': cfg.whisper_diarization,
            'speaker_reference_version': 3,
            'batch_size': cfg.whisper_batch_size,
            'download_root': cfg.whisper_download_root,
            'min_speakers': cfg.whisper_min_speakers,
            'max_speakers': cfg.whisper_max_speakers,
            'align_fallback': cfg.whisper_align_fallback,
            'diarization_model': cfg.whisper_diarization_model,
            'diarization_available': bool(cfg.hf_token),
            'upstream_vocals': _file_input_token(os.path.join(folder, 'audio_vocals.wav')),
        },
        [
            os.path.join(folder, 'transcript.json'),
        ],
    )


def _translation_spec(folder: str, cfg: PipelineConfig) -> tuple[str, dict, list[str]]:
    return (
        'step030_translation',
        {
            'translation_target_language': cfg.translation_target_language,
            'translation': cfg.translation.fingerprint(),
            'upstream_info': _file_input_token(os.path.join(folder, 'download.info.json')),
            'upstream_transcript': _file_input_token(os.path.join(folder, 'transcript.json')),
        },
        [
            os.path.join(folder, 'translation.json'),
            os.path.join(folder, 'summary.json'),
        ],
    )


def _tts_spec(folder: str, cfg: PipelineConfig) -> tuple[str, dict, list[str], list[str]]:
    return (
        'step040_tts',
        {
            'tts_engine': cfg.tts_engine,
            'speaker_references': reference_fingerprint(folder),
            'text_normalization': normalization_identity(cfg.tts_engine),
            'target_language': cfg.translation_target_language,
            'formation_tts_style': cfg.formation_tts_style,
            'xtts_model_path': cfg.xtts_model_path,
            'upstream_translation': _file_input_token(os.path.join(folder, 'translation.json')),
            'upstream_vocals': _file_input_token(os.path.join(folder, 'audio_vocals.wav')),
            'upstream_instruments': _file_input_token(os.path.join(folder, 'audio_instruments.wav')),
        },
        [
            os.path.join(folder, 'audio_combined.wav'),
            os.path.join(folder, 'translation_tts.json'),
        ],
        [
            os.path.join(folder, 'wavs'),
            os.path.join(folder, 'audio_tts.wav'),
        ],
    )


def _video_spec(folder: str, cfg: PipelineConfig) -> tuple[str, dict, list[str]]:
    aligned_json = os.path.join(folder, 'translation_tts.json')
    sub_json = aligned_json if os.path.isfile(aligned_json) else os.path.join(folder, 'translation.json')
    return (
        'step050_synthesize_video',
        {
            'tts_engine': cfg.tts_engine,
            'target_language': cfg.translation_target_language,
            'subtitles': cfg.subtitles,
            'font': cfg.subtitle_font,
            'speed_up': cfg.speed_up,
            'fps': cfg.fps,
            'target_resolution': cfg.target_resolution,
            'upstream_video': _file_input_token(os.path.join(folder, 'download.mp4')),
            'upstream_audio': _file_input_token(os.path.join(folder, 'audio_combined.wav')),
            'upstream_subtitles_json': _file_input_token(sub_json),
        },
        [
            os.path.join(folder, 'video.mp4'),
        ],
    )


def _info_spec(folder: str, cfg: PipelineConfig) -> tuple[str, dict, list[str]]:
    return (
        'step060_generate_info',
        {
            'target_language': cfg.translation_target_language,
            'upstream_summary': _file_input_token(os.path.join(folder, 'summary.json')),
            'upstream_info': _file_input_token(os.path.join(folder, 'download.info.json')),
        },
        [
            os.path.join(folder, 'video.txt'),
        ],
    )


def _cfg_with_device(cfg: PipelineConfig, device: str) -> PipelineConfig:
    if not isinstance(device, str):
        return cfg
    return replace(
        cfg,
        demucs_device=device,
        whisper_device=device,
        tts_device=device,
    )


# ── core pipeline (single folder) ────────────────────────────────────
def _run_pipeline(folder: str, cfg: PipelineConfig) -> None:
    """Execute the full pipeline for one video folder, skipping cached steps."""

    from .utils import should_skip_step, mark_step_done

    logger.info(f"[Pipeline] START  folder={folder}")

    # ── Step 1: extract audio + vocal separation ──────────────────────
    s1_name, s1_params, s1_outputs = _vocals_spec(folder, cfg)
    if not should_skip_step(
        folder, s1_name, s1_params, s1_outputs,
        extra_cleanup_paths=[os.path.join(folder, 'audio.wav')],
    ):
        if not _cache_audio(folder):
            logger.info("[Step 1] Extracting audio from video ...")
            _execute_stage('separation', 'step010_demucs_vr.extract_audio_from_video', folder)
        logger.info("[Step 1] Separating vocals / instruments ...")
        _execute_stage('separation', 'step010_demucs_vr.separate_audio',
            folder,
            model_name=cfg.demucs_model,
            device=cfg.demucs_device,
            progress=True,
            shifts=cfg.demucs_shifts,
        )
        mark_step_done(folder, s1_name, s1_params, s1_outputs)
    else:
        logger.info("[Step 1] SKIP — vocals already separated")

    # ── Step 2: speech recognition ────────────────────────────────────
    s2_name, s2_params, s2_outputs = _transcript_spec(folder, cfg)
    s2_skip = should_skip_step(
        folder, s2_name, s2_params, s2_outputs,
        extra_cleanup_paths=[os.path.join(folder, 'SPEAKER')],
    )
    if s2_skip and not has_speaker_wavs(folder):
        # Regenerate if SPEAKER reference wavs were removed independently.
        for stale_p in (s2_outputs[0], os.path.join(folder, f'.{s2_name}.fingerprint')):
            try:
                os.remove(stale_p)
            except OSError:
                pass
        s2_skip = False
    if not s2_skip:
        logger.info("[Step 2] Transcribing speech ...")
        _execute_stage('transcription', 'step020_whisperx.transcribe_audio',
            folder,
            model_name=cfg.whisper_model,
            download_root=cfg.whisper_download_root,
            device=cfg.whisper_device,
            batch_size=cfg.whisper_batch_size,
            diarization=cfg.whisper_diarization,
            min_speakers=cfg.whisper_min_speakers,
            max_speakers=cfg.whisper_max_speakers,
            source_language=cfg.source_language,
            align_fallback=cfg.whisper_align_fallback,
            diarization_model=cfg.whisper_diarization_model,
            hf_token=cfg.hf_token,
        )
        mark_step_done(folder, s2_name, s2_params, s2_outputs)
    else:
        logger.info("[Step 2] SKIP — transcript already exists")

    # ── Step 3: translation ───────────────────────────────────────────
    s3_name, s3_params, s3_outputs = _translation_spec(folder, cfg)
    if not should_skip_step(
        folder, s3_name, s3_params, s3_outputs,
    ):
        logger.info("[Step 3] Translating subtitles ...")
        _execute_stage('translation', 'step030_translation.translate', folder, target_language=cfg.translation_target_language, settings=cfg.translation)
        mark_step_done(folder, s3_name, s3_params, s3_outputs)
    else:
        logger.info("[Step 3] SKIP — translation already cached")

    # ── Step 4: TTS ───────────────────────────────────────────────────
    s4_name, s4_params, s4_outputs, s4_extra = _tts_spec(folder, cfg)
    if not should_skip_step(folder, s4_name, s4_params, s4_outputs, extra_cleanup_paths=s4_extra):
        logger.info("[Step 4] Generating TTS audio ...")
        _execute_stage('tts', 'step040_tts.generate_wavs',
            folder,
            tts_engine=cfg.tts_engine,
            tts_device=cfg.tts_device,
            model_path=cfg.xtts_model_path,
            formation_style=cfg.formation_tts_style,
            target_language=cfg.translation_target_language,
        )
        mark_step_done(folder, s4_name, s4_params, s4_outputs)
    else:
        logger.info("[Step 4] SKIP — TTS audio already generated")

    # ── Step 5: video compositing ─────────────────────────────────────
    s5_name, s5_params, s5_outputs = _video_spec(folder, cfg)
    if not should_skip_step(
        folder, s5_name, s5_params, s5_outputs,
        extra_cleanup_paths=[os.path.join(folder, 'subtitles.srt')],
    ):
        logger.info("[Step 5] Compositing final video ...")
        _execute_stage('video', 'step050_synthesize_video.synthesize_video',
            folder,
            subtitles=cfg.subtitles,
            speed_up=cfg.speed_up,
            fps=cfg.fps,
            resolution=cfg.target_resolution,
            font_name=cfg.subtitle_font,
        )
        mark_step_done(folder, s5_name, s5_params, s5_outputs)
    else:
        logger.info("[Step 5] SKIP — final video already exists")

    # ── Step 6: info / thumbnail ──────────────────────────────────────
    if not cfg.generate_metadata:
        return
    s6_name, s6_params, s6_outputs = _info_spec(folder, cfg)
    if not should_skip_step(folder, s6_name, s6_params, s6_outputs):
        logger.info("[Step 6] Generating info / thumbnail ...")
        _execute_stage('metadata', 'step060_generate_info.generate_info', folder)
        mark_step_done(folder, s6_name, s6_params, s6_outputs)
    else:
        logger.info("[Step 6] SKIP — info already generated")

    logger.info(f"[Pipeline] DONE   folder={folder}")


def _parse_multi_input(raw: str, is_local_paths: bool = False) -> list[str]:
    """Parse newline- or comma-separated inputs without splitting commas inside
    existing file paths (e.g. '你好，世界.mp4') or single URLs (e.g. 'https://a.com/x,y')."""
    if raw is None:
        return []
    raw_str = str(raw).strip()
    if not raw_str:
        return []

    items = []
    for raw_line in raw_str.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        # Never split an existing local path that literally contains ',' or '，'.
        if os.path.exists(line):
            items.append(line)
            continue

        if is_local_paths:
            parts = [p.strip() for p in re.split(r'[，,]', line) if p.strip()]
            # If splitting broke a single non-existent path vs multiple paths, keep parts
            items.extend(parts)
        else:
            # For URLs, only split on commas when followed by another URL scheme if schemes are present.
            if re.search(r'(?:https?|rtmp|rtsp|ftp)://', line, flags=re.IGNORECASE):
                parts = [
                    p.strip()
                    for p in re.split(r'[，,]\s*(?=(?:https?|rtmp|rtsp|ftp)://)', line, flags=re.IGNORECASE)
                    if p.strip()
                ]
            else:
                parts = [p.strip() for p in re.split(r'[，,]', line) if p.strip()]
            items.extend(parts)
    return items



@dataclass(frozen=True)
class TaskResult:
    source: str
    folder: str | None
    success: bool
    artifacts: dict[str, str]
    error_stage: str | None = None
    error: str | None = None


@dataclass(frozen=True)
class BatchResult:
    tasks: tuple[TaskResult, ...]

    def summary(self, include_folders=False):
        ok = sum(task.success for task in self.tasks)
        text = f"Success: {ok}  Fail: {len(self.tasks) - ok}"
        if include_folders:
            text += f"\nFolders: {[task.folder or task.source for task in self.tasks]}"
        return text


class StageError(RuntimeError):
    def __init__(self, stage, cause):
        super().__init__(str(cause))
        self.stage = stage


def _execute_stage(stage, function, *args, **kwargs):
    try:
        module, name = function.rsplit('.', 1)
        return getattr(importlib.import_module('.' + module, __package__), name)(*args, **kwargs)
    except Exception as exc:
        raise StageError(stage, exc) from exc


def _run_pipeline_with_retries(folder, cfg, source=None):
    error = None
    for attempt in range(1, cfg.max_retries + 1):
        try:
            _run_pipeline(folder, cfg)
            artifacts = {
                name: os.path.join(folder, name)
                for name in ('video.mp4', 'subtitles.srt', 'translation.json',
                             'translation_tts.json', 'audio_combined.wav', 'video.txt', 'video.png')
                if os.path.isfile(os.path.join(folder, name))
                and (cfg.generate_metadata or name not in ('video.txt', 'video.png'))
            }
            return TaskResult(source or folder, folder, True, artifacts)
        except Exception as exc:
            error = exc
            logger.error(f'Pipeline attempt {attempt}/{cfg.max_retries}, folder={folder}: {exc}')
    return TaskResult(source or folder, folder, False, {},
                      getattr(error, 'stage', 'pipeline'), str(error))


def run_tasks(inputs, cfg=None, *, source='local', xtts_cpml_ack=False):
    """Return structured results in input order; source is local, online or folder.

    folder accepts the existing download.mp4 artifact layout, allowing a host
    project to own acquisition. No models are preloaded for cached stages.
    """
    cfg = cfg or PipelineConfig()
    validate_engine_and_language(cfg.tts_engine, cfg.translation_target_language, xtts_cpml_ack)
    if cfg.tts_engine == 'xtts' and not cfg.xtts_model_path:
        raise ValueError('XTTS requires a configured local model path')
    if source not in ('local', 'online', 'folder'):
        raise ValueError(f'Unknown input source: {source}')
    if cfg.max_workers < 1 or cfg.max_retries < 1:
        raise ValueError('max_workers and max_retries must be positive')
    items = _parse_multi_input(inputs, is_local_paths=source != 'online') if isinstance(inputs, str) else list(inputs)
    if source == 'online':
        from .step000_video_downloader import get_info_list_from_url
        items = list(get_info_list_from_url(items, cfg.num_videos)) if items else []
    if not items:
        return BatchResult(())

    def process(item, device):
        label = str(item.get('webpage_url') or item.get('url') or item.get('title')) if isinstance(item, dict) else str(item)
        folder = None
        try:
            if source == 'online':
                from .step000_video_downloader import download_single_video
                folder = download_single_video(item, cfg.root_folder, cfg.resolution)
                if folder is None:
                    raise RuntimeError('Video download failed')
            elif source == 'local':
                folder = _prepare_local_video_folder(str(item), cfg.root_folder)
            else:
                folder = os.path.abspath(item)
                if not os.path.isfile(os.path.join(folder, 'download.mp4')):
                    raise FileNotFoundError(f'Missing prepared input: {folder}/download.mp4')
            return _run_pipeline_with_retries(folder, _cfg_with_device(cfg, device), label)
        except Exception as exc:
            return TaskResult(label, folder, False, {}, 'input', str(exc))

    from .utils import reserved_cuda_devices
    worker_count = min(cfg.max_workers, len(items))
    with reserved_cuda_devices(worker_count) as devices:
        if worker_count == 1:
            return BatchResult(tuple(process(item, devices[0]) for item in items))
        with ThreadPoolExecutor(max_workers=worker_count) as pool:
            futures = [pool.submit(process, item, devices[i % len(devices)])
                       for i, item in enumerate(items)]
            return BatchResult(tuple(future.result() for future in futures))


def process_online_video(
    url, root_folder='videos', download_resolution='1080p', max_videos=20,
    source_language='auto', target_language='简体中文', tts_engine='cosyvoice',
    burn_subtitles=True, speed_up=1.05, max_workers=1, xtts_cpml_ack=False,
):
    """Compatibility/UI adapter; reusable callers should use run_tasks."""
    urls = _parse_multi_input(url)
    if len(urls) == 1 and os.path.isfile(urls[0]):
        return process_local_video(urls[0], root_folder=root_folder,
            source_language=source_language, target_language=target_language,
            tts_engine=tts_engine, burn_subtitles=burn_subtitles, speed_up=speed_up,
            max_workers=max_workers, xtts_cpml_ack=xtts_cpml_ack,
            target_resolution=download_resolution)
    cfg = PipelineConfig(root_folder=root_folder, resolution=download_resolution,
        target_resolution=download_resolution, num_videos=max_videos,
        source_language=source_language, translation_target_language=target_language,
        tts_engine=tts_engine, subtitles=burn_subtitles, speed_up=speed_up,
        max_workers=max(1, int(max_workers)))
    result = run_tasks(urls, cfg, source='online', xtts_cpml_ack=xtts_cpml_ack)
    return result.summary() if result.tasks else 'Error: no downloadable video found.'


def process_local_video(
    file_path, root_folder='videos', source_language='auto', target_language='简体中文',
    tts_engine='cosyvoice', burn_subtitles=True, speed_up=1.05, max_workers=1,
    xtts_cpml_ack=False, target_resolution='1080p',
):
    """Compatibility/UI adapter over the shared structured executor."""
    cfg = PipelineConfig(root_folder=root_folder, source_language=source_language,
        translation_target_language=target_language, tts_engine=tts_engine,
        subtitles=burn_subtitles, speed_up=speed_up, max_workers=max(1, int(max_workers)),
        target_resolution=target_resolution)
    result = run_tasks(file_path, cfg, source='local', xtts_cpml_ack=xtts_cpml_ack)
    return result.summary(include_folders=True) if result.tasks else 'Error: no valid local video path provided.'
