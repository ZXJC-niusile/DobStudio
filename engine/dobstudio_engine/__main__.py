import argparse
import contextlib
import json
import sys
from pathlib import Path
from .protocol import validate_manifest

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--manifest', type=Path)
    parser.add_argument('--check', action='store_true')
    parser.add_argument('--preflight', action='store_true')
    parser.add_argument('--engine', choices=('cosyvoice', 'xtts'), default='cosyvoice')
    parser.add_argument('--model-path')
    parser.add_argument('--separate-bgm', action='store_true')
    args = parser.parse_args()
    try:
        if args.preflight:
            from .preflight import check_runtime
            print(json.dumps(check_runtime(args.engine, args.model_path, args.separate_bgm)))
            return 0
        if not args.manifest:
            raise ValueError('--manifest is required')
        data = validate_manifest(json.loads(args.manifest.read_text(encoding='utf-8')))
        if args.check:
            print(json.dumps({'version': 1, 'type': 'validated', 'cueCount': len(data['cues'])}))
            return 0
        from .worker import render
        # Model libraries may print diagnostics; stdout is reserved for JSONL.
        def emit(event):
            sys.__stdout__.write(json.dumps({'version': 1, **event}, ensure_ascii=False)+'\n')
            sys.__stdout__.flush()
        with contextlib.redirect_stdout(sys.stderr):
            result = render(data, emit)
        emit({'type': 'result', 'result': result})
        return 0
    except Exception as exc:
        print(json.dumps({'version':1, 'type':'error', 'message':str(exc)}, ensure_ascii=False), flush=True)
        return 1

if __name__ == '__main__':
    raise SystemExit(main())
