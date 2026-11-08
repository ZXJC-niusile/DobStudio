#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

ENV_NAME="${ENV_NAME:-omnidub}"
PY_VER="${PY_VER:-3.10}"
CUDA_INDEX_URL="${CUDA_INDEX_URL:-https://download.pytorch.org/whl/cu128}"
INSTALL_XTTS="${INSTALL_XTTS:-0}"

echo "[precheck] verify required system binaries (repo: ${REPO_ROOT})"
command -v conda >/dev/null 2>&1 || { echo "ERROR: conda not found in PATH"; exit 1; }
command -v ffmpeg >/dev/null 2>&1 || {
  echo "ERROR: ffmpeg not found. Please install ffmpeg first.";
  echo "Ubuntu example: sudo apt-get update && sudo apt-get install -y ffmpeg";
  exit 1;
}

echo "[1/5] Ensure conda env: ${ENV_NAME} (python=${PY_VER})"
if conda env list | awk '{print $1}' | grep -qx "${ENV_NAME}"; then
  echo "Conda env exists: ${ENV_NAME}"
else
  conda create -y -n "${ENV_NAME}" "python=${PY_VER}"
fi

echo "[2/5] Install CUDA PyTorch stack"
conda run -n "${ENV_NAME}" pip install --upgrade pip setuptools wheel
conda run -n "${ENV_NAME}" pip install --index-url "${CUDA_INDEX_URL}" torch torchvision torchaudio

echo "[3/5] Install the selected runtime dependency graph"
REQUIREMENTS_FILE="${REPO_ROOT}/requirements.txt"
SMOKE_ARGS=()
if [[ "${INSTALL_XTTS}" == "1" ]]; then
  REQUIREMENTS_FILE="${REPO_ROOT}/requirements-xtts.txt"
  SMOKE_ARGS+=(--xtts)
fi
conda run -n "${ENV_NAME}" pip install -r "${REQUIREMENTS_FILE}"

echo "[4/5] Check dependency consistency"
conda run -n "${ENV_NAME}" pip check

echo "[5/5] Check real engine imports and text frontend"
conda run -n "${ENV_NAME}" python "${REPO_ROOT}/scripts/check_runtime.py" "${SMOKE_ARGS[@]}"

echo ""
echo "Install finished."
echo "Next steps:"
echo "  1. conda activate ${ENV_NAME}"
echo "  2. cp .env.example .env  # then fill in your API keys"
echo "  3. python app.py"
