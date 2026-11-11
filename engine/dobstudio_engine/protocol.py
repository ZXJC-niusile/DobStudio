"""Versioned task boundary: standard library only, validated before imports."""
import math
from pathlib import Path

def validate_manifest(data):
    if not isinstance(data, dict) or data.get('version') != 1:
        raise ValueError('Unsupported task manifest version')
    engine = data.get('engine')
    if engine is not None:
        if engine not in ('cosyvoice', 'xtts'):
            raise ValueError("engine must be either 'cosyvoice' or 'xtts'")
    data.setdefault('engine', 'cosyvoice')
    separate_bgm = data.get('separateBgm')
    if separate_bgm is not None:
        if not isinstance(separate_bgm, bool):
            raise ValueError('separateBgm must be a boolean')
    data.setdefault('separateBgm', False)
    ducking = data.get('ducking')
    if ducking is not None:
        if not isinstance(ducking, bool):
            raise ValueError('ducking must be a boolean')
    data.setdefault('ducking', True)
    bgm_volume = data.get('bgmVolume')
    if bgm_volume is not None:
        if isinstance(bgm_volume, bool) or not isinstance(bgm_volume, (int, float)) or not (0.0 <= bgm_volume <= 1.0):
            raise ValueError('bgmVolume must be a float between 0.0 and 1.0')
    data.setdefault('bgmVolume', 0.3)
    xtts_model_path = data.get('xttsModelPath')
    if xtts_model_path is not None:
        if not isinstance(xtts_model_path, str):
            raise ValueError('xttsModelPath must be a string')
    req_paths = ['mediaPath', 'outputDir', 'referencePath', 'ffmpeg', 'ffprobe']
    req_paths.append('xttsModelPath' if data['engine'] == 'xtts' else 'modelPath')
    for key in req_paths:
        if not isinstance(data.get(key), str) or not Path(data[key]).is_absolute():
            raise ValueError(f'{key} must be an absolute path')
    if data.get('device') not in ('cpu', 'cuda'):
        raise ValueError('Device must be cpu or cuda')
    for key in ('targetLanguage','referenceLanguage','referenceText'):
        if not isinstance(data.get(key),str): raise ValueError(f'{key} must be a string')
    if not data['targetLanguage'].strip(): raise ValueError('Target language is required')
    cues=data.get('cues')
    if not isinstance(cues,list) or not cues: raise ValueError('No subtitles to synthesize')
    end=0
    for cue in cues:
        start,stop=cue.get('startMs'),cue.get('endMs')
        if any(isinstance(v,bool) or not isinstance(v,(int,float)) or not math.isfinite(v) for v in (start,stop)) or start<end or stop<=start:
            raise ValueError('Subtitle intervals must be finite, ordered and non-overlapping')
        if not isinstance(cue.get('translation'),str) or not cue['translation'].strip():
            raise ValueError('Every subtitle requires translated speech text')
        end=stop
    return data
