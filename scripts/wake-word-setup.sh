#!/usr/bin/env bash
# Setup ÚNICO USO (ou de novo se o venv for apagado) pro gatilho de
# escuta contínua (Fase 10, ver docs/architecture.md) — cria um venv
# Python ISOLADO do Python do sistema (evita o erro
# "externally-managed-environment" do Homebrew, achado real testando
# nesta máquina) e baixa os modelos prontos do openWakeWord (~6MB).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV_DIR="$ROOT_DIR/packages/wake-word/.venv"

echo "Criando venv em $VENV_DIR..."
python3 -m venv "$VENV_DIR"

echo "Instalando dependências..."
"$VENV_DIR/bin/pip" install --quiet --upgrade pip
"$VENV_DIR/bin/pip" install --quiet -r "$ROOT_DIR/packages/wake-word/python/requirements.txt"

echo "Baixando modelos prontos do openWakeWord (alexa, hey_jarvis, hey_mycroft, hey_rhasspy, timer, weather)..."
"$VENV_DIR/bin/python" -c "import openwakeword.utils; openwakeword.utils.download_models()"

echo "Pronto. Placeholder de wake-word: hey_jarvis (diga 'hey jarvis' até treinar um modelo 'SARAH' customizado — ver docs/architecture.md, Fase 10)."
