import inspect

import gradio as gr
from youdub.pipeline import process_local_video, process_online_video
from youdub.config import validate_engine_and_language, TARGET_LANGUAGES, SOURCE_LANGUAGES


def _xtts_gate(process_fn):
    """Gate calls to *process_fn* behind CPML acknowledgment and language compatibility checks.

    Uses ``inspect.signature(process_fn).bind_partial`` + ``apply_defaults`` so positional
    Gradio widget inputs, keyword arguments, and default parameter values are resolved
    deterministically without fragile index slicing.
    """
    sig = inspect.signature(process_fn)

    def wrapped(*args, **kwargs):
        bound = sig.bind_partial(*args, **kwargs)
        bound.apply_defaults()

        ack = bool(bound.arguments.get('xtts_cpml_ack', False))
        tts_engine = bound.arguments.get('tts_engine')
        target_language = bound.arguments.get('target_language')

        try:
            validate_engine_and_language(tts_engine, target_language, ack)
        except ValueError as exc:
            return f'ERROR: {exc}'

        bound.arguments['xtts_cpml_ack'] = ack
        return process_fn(*bound.args, **bound.kwargs)

    return wrapped


def create_app():
    online_tab = gr.Interface(
        fn=_xtts_gate(process_online_video),
        inputs=[
            gr.Textbox(label='Video URL', placeholder='YouTube / playlist / channel URL', value=''),
            gr.Textbox(label='Root Folder', value='videos'),
            gr.Radio(['1080p', '2160p', '720p', '480p'], label='Download Resolution', value='1080p'),
            gr.Slider(1, 100, step=1, label='Max Videos', value=20),
            gr.Dropdown(
                list(SOURCE_LANGUAGES),
                label='Source Language', value='auto'),
            gr.Dropdown(
                list(TARGET_LANGUAGES),
                label='Target Language', value='简体中文'),
            gr.Dropdown(['cosyvoice', 'xtts'], label='TTS Engine', value='cosyvoice'),
            gr.Checkbox(label='Burn Subtitles', value=True),
            gr.Slider(0.5, 2.0, step=0.05, label='Speed Up', value=1.05),
            gr.Slider(1, 8, step=1, label='Parallel Workers', value=1),
            gr.Checkbox(
                label='I acknowledge XTTS v2 is licensed under CPML (non-commercial only)',
                value=False,
            ),
        ],
        outputs='text',
    )

    local_tab = gr.Interface(
        fn=_xtts_gate(process_local_video),
        inputs=[
            gr.Textbox(label='Local Video Path(s)', placeholder='/abs/path/to/video1.mp4,/abs/path/to/video2.mp4', value=''),
            gr.Textbox(label='Root Folder', value='videos'),
            gr.Dropdown(
                list(SOURCE_LANGUAGES),
                label='Source Language', value='auto'),
            gr.Dropdown(
                list(TARGET_LANGUAGES),
                label='Target Language', value='简体中文'),
            gr.Dropdown(['cosyvoice', 'xtts'], label='TTS Engine', value='cosyvoice'),
            gr.Checkbox(label='Burn Subtitles', value=True),
            gr.Slider(0.5, 2.0, step=0.05, label='Speed Up', value=1.05),
            gr.Slider(1, 8, step=1, label='Parallel Workers', value=1),
            gr.Checkbox(
                label='I acknowledge XTTS v2 is licensed under CPML (non-commercial only)',
                value=False,
            ),
        ],
        outputs='text',
    )

    app = gr.TabbedInterface(
        interface_list=[online_tab, local_tab],
        tab_names=['Online Video', 'Local Video'],
        title='OmniDub Studio',
    )
    return app


if __name__ == '__main__':
    from dotenv import load_dotenv
    load_dotenv()
    create_app().launch()
