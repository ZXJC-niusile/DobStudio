import json
import os
from pathlib import Path
import subprocess
import wave

def command(args, timeout=600):
    done = subprocess.run(
        [str(a) for a in args],
        capture_output=True,
        text=True,
        encoding='utf-8',
        errors='replace',
        check=False,
        timeout=timeout,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
    )
    if done.returncode:
        raise RuntimeError(done.stderr[-4000:] or f'Process exited {done.returncode}')
    return done.stdout

def silence(wav, frames):
    block = b'\0' * (24000 * 2)
    while frames > 0:
        n = min(frames, 24000)
        wav.writeframesraw(block[:n * 2])
        frames -= n

def render(data, emit):
    if data['device'] == 'cpu':
        os.environ['CUDA_VISIBLE_DEVICES'] = ''
    for key in ('mediaPath', 'referencePath', 'ffmpeg', 'ffprobe'):
        if not Path(data[key]).is_file():
            raise ValueError(f'{key} does not exist')
    out = Path(data['outputDir'])
    out.mkdir(parents=True, exist_ok=True)
    # Validate the complete reference recording.
    with wave.open(data['referencePath'], 'rb') as ref:
        seconds = ref.getnframes() / ref.getframerate()
        if not 0.5 <= seconds <= 29:
            raise ValueError('Reference WAV must contain a complete 0.5–29 second utterance')
    duration = float(command([
        data['ffprobe'], '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        data['mediaPath']
    ]).strip())
    if data['cues'][-1]['endMs'] > duration * 1000 + 50:
        raise ValueError('Subtitles extend beyond the source video')

    separate_bgm = bool(data.get('separateBgm', False))
    instruments = None
    if separate_bgm:
        emit({'type': 'stage', 'stage': 'separating-bgm'})
        instruments = out / 'instruments.wav'
        import importlib.util
        import sys
        if importlib.util.find_spec('demucs') is None:
            raise RuntimeError('Background separation requires Demucs. Install engine/requirements-bgm.txt in the selected Python environment.')
        # Give Demucs an explicit PCM source: it need not locate ffmpeg on PATH.
        source_audio = out / 'separation_input.wav'
        command([data['ffmpeg'], '-v', 'error', '-y', '-i', data['mediaPath'],
                 '-vn', '-ar', '44100', '-ac', '2', '-c:a', 'pcm_s16le', source_audio])
        temp_demucs = out / 'demucs_temp'
        try:
            command([sys.executable, '-m', 'demucs', '--two-stems=vocals',
                     '-n', 'htdemucs', '-d', data['device'], '-o', temp_demucs,
                     source_audio], timeout=24 * 3600)
            stem = temp_demucs / 'htdemucs' / source_audio.stem / 'no_vocals.wav'
            if not stem.is_file():
                raise RuntimeError('Demucs returned no accompaniment stem')
            command([data['ffmpeg'], '-v', 'error', '-y', '-i', stem,
                     '-ar', '24000', '-ac', '2', '-c:a', 'pcm_s16le', instruments])
        except Exception as error:
            raise RuntimeError(f'Background separation failed: {error}') from error

    emit({'type': 'stage', 'stage': 'loading-model'})
    engine_name = data.get('engine', 'cosyvoice')
    if engine_name == 'xtts':
        from .xtts_adapter import Synthesizer
        model_path = data.get('xttsModelPath')
        engine = Synthesizer(model_path, data['device'], target_language=data.get('targetLanguage', 'zh'))
    else:
        from .cosyvoice_adapter import Synthesizer
        engine = Synthesizer(data['modelPath'], data['device'])

    # User supplies the verbatim text of this exact WAV; cross-language uses audio only.
    prompt = data['referenceText'].strip() if data['referenceLanguage'] == data['targetLanguage'] else ''
    audio = out / 'dubbing.wav'
    with wave.open(str(audio), 'wb') as track:
        track.setnchannels(1)
        track.setsampwidth(2)
        track.setframerate(24000)
        cursor = 0
        for i, cue in enumerate(data['cues']):
            emit({'type': 'stage', 'stage': f'synthesizing {i+1}/{len(data["cues"])}'})
            raw = out / f'segment-{i:05d}.wav'
            aligned = out / f'aligned-{i:05d}.wav'
            engine.synthesize(cue['translation'], data['referencePath'], prompt, raw)
            length = float(command([
                data['ffprobe'], '-v', 'error',
                '-show_entries', 'format=duration',
                '-of', 'default=noprint_wrappers=1:nokey=1',
                raw
            ]).strip())
            slot = (cue['endMs'] - cue['startMs']) / 1000
            ratio = max(1.0, length / slot)
            if ratio > 1.25:
                raise ValueError(f'Subtitle {i+1} needs {length:.2f}s in a {slot:.2f}s interval. Shorten its translation or extend its interval.')
            command([
                data['ffmpeg'], '-v', 'error', '-y',
                '-i', raw,
                '-af', f'atempo={ratio:.8f},apad',
                '-t', str(slot),
                '-ar', '24000',
                '-ac', '1',
                '-c:a', 'pcm_s16le',
                aligned
            ])
            start = round(cue['startMs'] * 24)
            silence(track, max(0, start - cursor))
            cursor = max(start, cursor)
            with wave.open(str(aligned), 'rb') as segment:
                frames = segment.getnframes()
                track.writeframesraw(segment.readframes(frames))
                cursor += frames
        silence(track, max(0, round(duration * 24000) - cursor))

    emit({'type': 'stage', 'stage': 'exporting-video'})
    video = out / 'dubbed.mp4'
    command([
        data['ffmpeg'], '-v', 'error', '-y',
        '-i', data['mediaPath'],
        '-i', audio,
        '-map', '0:v:0', '-map', '1:a:0',
        '-c:v', 'copy', '-c:a', 'aac',
        '-movflags', '+faststart',
        '-t', str(duration),
        video
    ])

    if separate_bgm and instruments and instruments.is_file():
        bgm_volume = float(data.get('bgmVolume', 0.3))
        ducking = bool(data.get('ducking', True))
        audio_with_bgm = out / 'dubbing_with_bgm.wav'
        video_with_bgm = out / 'dubbed_with_bgm.mp4'

        if ducking:
            filter_complex = (
                f"[0:a]aformat=sample_fmts=s16:sample_rates=24000:channel_layouts=stereo[voice];"
                f"[1:a]volume={bgm_volume:.4f},aformat=sample_fmts=s16:sample_rates=24000:channel_layouts=stereo[bgm];"
                f"[bgm][voice]sidechaincompress=threshold=0.03:ratio=4:attack=100:release=500[ducked];"
                f"[voice][ducked]amix=inputs=2:duration=first:dropout_transition=0[aout]"
            )
        else:
            filter_complex = (
                f"[0:a]aformat=sample_fmts=s16:sample_rates=24000:channel_layouts=stereo[voice];"
                f"[1:a]volume={bgm_volume:.4f},aformat=sample_fmts=s16:sample_rates=24000:channel_layouts=stereo[bgm];"
                f"[voice][bgm]amix=inputs=2:duration=first:dropout_transition=0[aout]"
            )

        command([
            data['ffmpeg'], '-v', 'error', '-y',
            '-i', audio,
            '-i', instruments,
            '-filter_complex', filter_complex,
            '-map', '[aout]',
            '-c:a', 'pcm_s16le',
            '-t', str(duration),
            audio_with_bgm
        ])

        command([
            data['ffmpeg'], '-v', 'error', '-y',
            '-i', data['mediaPath'],
            '-i', audio_with_bgm,
            '-map', '0:v:0', '-map', '1:a:0',
            '-c:v', 'copy', '-c:a', 'aac',
            '-movflags', '+faststart',
            '-t', str(duration),
            video_with_bgm
        ])

        result = {
            'videoPath': str(video),
            'videoPathWithBgm': str(video_with_bgm),
            'audioPath': str(audio),
            'audioPathWithBgm': str(audio_with_bgm),
            'bgmPath': str(instruments),
            'cueCount': len(data['cues']),
            'backgroundAudio': 'included'
        }
    else:
        result = {
            'videoPath': str(video),
            'audioPath': str(audio),
            'cueCount': len(data['cues']),
            'backgroundAudio': 'not-included'
        }

    (out / 'result.json').write_text(json.dumps(result, indent=2, ensure_ascii=False), encoding='utf-8')
    return result
