"""Bind ASR-derived prompt text to the exact reference WAV used for cloning.

This verifies provenance/integrity, not whether the ASR transcript is correct.
Unverified pairs can still be used as audio-only cross-lingual references.
"""
import hashlib
import json
import os


def audio_digest(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(65536), b''):
            digest.update(chunk)
    return digest.hexdigest()


def canonical_language(language):
    key = str(language or '').strip().lower()
    return {
        '简体中文': 'zh', '繁体中文': 'zh', 'zh-cn': 'zh', 'zh-tw': 'zh',
        'zh-hans': 'zh', 'zh-hant': 'zh', 'chinese': 'zh',
        'english': 'en', 'en-us': 'en', 'en-gb': 'en',
        'japanese': 'ja', 'korean': 'ko',
    }.get(key, key)


def write_reference_metadata(wav_path, text, language):
    with open(wav_path + '.reference.json', 'w', encoding='utf-8') as f:
        json.dump({
            'version': 1,
            'audio_sha256': audio_digest(wav_path),
            'text': text,
            'language': canonical_language(language),
        }, f, ensure_ascii=False, indent=2)


def verified_prompt(wav_path, text, target_language):
    """Return text only for an unchanged pair with a known matching language."""
    target = canonical_language(target_language)
    if not text or not target or target == 'auto':
        return ''
    try:
        with open(wav_path + '.reference.json', encoding='utf-8') as f:
            meta = json.load(f)
        if (meta.get('version') == 1 and meta.get('text') == text
                and meta.get('language') == target
                and meta.get('audio_sha256') == audio_digest(wav_path)):
            return text
    except (OSError, ValueError, AttributeError):
        pass
    return ''


def reference_fingerprint(folder):
    """Include changed reference audio/text/metadata in TTS cache identity."""
    directory = os.path.join(folder, 'SPEAKER')
    if not os.path.isdir(directory):
        return {}
    return {
        name: audio_digest(os.path.join(directory, name))
        for name in sorted(os.listdir(directory))
        if name.endswith(('.wav', '.txt', '.reference.json'))
        and not name.endswith('_30s.wav')
        and os.path.isfile(os.path.join(directory, name))
    }
