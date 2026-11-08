"""Lightweight task configuration; environment is read at task creation only."""
from dataclasses import dataclass, field
import os

TARGET_LANGUAGES = ('简体中文', '繁体中文', 'English', 'Deutsch', 'Français', 'русский')
SOURCE_LANGUAGES = ('auto', 'en', 'zh', 'ja', 'ko', 'fr', 'de', 'ru', 'es')
ENGINE_LANGUAGES = {
    'cosyvoice': frozenset(('zh', 'en', 'ja', 'ko')),
    'xtts': frozenset(('zh', 'en', 'ja', 'ko', 'de', 'fr', 'ru', 'es')),
}


def canonical_language(language):
    key = str(language or '').strip().lower()
    return {
        '简体中文': 'zh', '繁体中文': 'zh', 'zh-cn': 'zh', 'zh-tw': 'zh',
        'zh-hans': 'zh', 'zh-hant': 'zh', 'chinese': 'zh',
        'english': 'en', 'en-us': 'en', 'en-gb': 'en',
        'japanese': 'ja', 'korean': 'ko', 'deutsch': 'de',
        'français': 'fr', 'francais': 'fr', 'русский': 'ru',
        'español': 'es', 'espanol': 'es',
    }.get(key, key)


def validate_engine_and_language(engine, language, xtts_cpml_ack=False):
    if engine not in ENGINE_LANGUAGES:
        raise ValueError(f'Unknown TTS engine: {engine}')
    if engine == 'xtts' and not xtts_cpml_ack:
        raise ValueError('XTTS v2 requires explicit CPML acknowledgment. Set xtts_cpml_ack=True or use cosyvoice.')
    if canonical_language(language) not in ENGINE_LANGUAGES[engine]:
        raise ValueError(f'{"CosyVoice-300M" if engine == "cosyvoice" else "XTTS v2"} does not support target language "{language}". Select a supported language or another engine.')


@dataclass(frozen=True)
class TranslationConfig:
    model: str = 'gpt-3.5-turbo'
    batch_size: int = 10
    base_url: str = 'https://api.openai.com/v1'
    api_key: str | None = field(default=None, repr=False, compare=False)
    repetition_penalty: float | None = None

    @classmethod
    def from_env(cls):
        try:
            batch = max(1, int(os.getenv('TRANSLATION_BATCH_SIZE', '10')))
        except ValueError:
            batch = 10
        try:
            penalty = float(os.getenv('OMNIDUB_REPETITION_PENALTY', '0'))
        except ValueError:
            penalty = 0
        return cls(os.getenv('MODEL_NAME', 'gpt-3.5-turbo'), batch,
                   os.getenv('OPENAI_API_BASE', 'https://api.openai.com/v1'),
                   os.getenv('OPENAI_API_KEY'), penalty if penalty > 1 else None)

    @property
    def extra_body(self):
        return {'repetition_penalty': self.repetition_penalty} if self.repetition_penalty else None

    def fingerprint(self):
        return {'model': self.model, 'batch_size': self.batch_size,
                'base_url': self.base_url, 'repetition_penalty': self.repetition_penalty}


@dataclass(frozen=True)
class PipelineConfig:
    """Immutable pipeline settings with sensible production defaults."""

    root_folder: str = "videos"

    # Step 0 — download
    resolution: str = "1080p"
    num_videos: int = 20

    # Step 1 — demucs
    demucs_model: str = "htdemucs_ft"
    demucs_device: str = "auto"
    demucs_shifts: int = 5

    # Step 2 — whisperx
    whisper_model: str = "large"
    whisper_download_root: str = "models/ASR/whisper"
    whisper_batch_size: int = 32
    whisper_device: str = "auto"
    source_language: str = "auto"
    whisper_diarization: bool = True
    whisper_min_speakers: int | None = None
    whisper_max_speakers: int | None = None

    whisper_align_fallback: str = field(default_factory=lambda: os.getenv('WHISPERX_ALIGN_FALLBACK_LANGUAGE', 'en'))
    whisper_diarization_model: str | None = field(default_factory=lambda: os.getenv('WHISPERX_DIARIZATION_MODEL'))
    hf_token: str | None = field(default_factory=lambda: os.getenv('HF_TOKEN') or os.getenv('HUGGINGFACE_TOKEN'), repr=False, compare=False)

    # Step 3 — translation
    translation_target_language: str = "简体中文"

    translation: TranslationConfig = field(default_factory=TranslationConfig.from_env)

    # Step 4 — TTS
    tts_engine: str = "cosyvoice"  # "cosyvoice" | "xtts"
    tts_device: str = "auto"

    xtts_model_path: str | None = field(default_factory=lambda: os.getenv('OMNIDUB_XTTS_LOCAL_PATH'))
    formation_tts_style: str = field(default_factory=lambda: os.getenv('FORMATION_TTS_STYLE', 'chinese_compact'))

    # Step 5 — video compositing
    subtitles: bool = True
    speed_up: float = 1.05
    fps: int = 30
    target_resolution: str = "1080p"

    subtitle_font: str = field(default_factory=lambda: os.getenv('SUBTITLE_FONT_NAME', 'sans-serif'))
    generate_metadata: bool = True

    # Misc
    max_retries: int = 3
    max_workers: int = 1



    def __post_init__(self):
        if self.xtts_model_path:
            object.__setattr__(self, 'xtts_model_path', os.path.normcase(
                os.path.abspath(os.path.expanduser(self.xtts_model_path))))
