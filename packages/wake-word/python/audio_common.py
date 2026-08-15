"""
Utilitário compartilhado entre `listener.py` (escuta contínua: wake-
word + palmas + VAD, Fase 10) e `silence_watcher.py` (fim de fala por
silêncio, mesma fase, ajuste posterior) — os dois são processos
Python separados (vidas diferentes: um roda enquanto a escuta
contínua estiver ligada, o outro só durante UMA gravação), mas fazem
o MESMO tipo de análise de base (amplitude de áudio ao longo do
tempo), então o protocolo de saída (JSON por linha em stdout, log em
stderr) e as constantes de captura ficam aqui, uma vez só.
"""

import json
import sys

SAMPLE_RATE = 16000
CHUNK_SAMPLES = 1280  # 80ms @ 16kHz


def emit(event: dict) -> None:
    sys.stdout.write(json.dumps(event) + "\n")
    sys.stdout.flush()


def make_logger(tag: str):
    def log(message: str) -> None:
        sys.stderr.write(f"[{tag}] {message}\n")
        sys.stderr.flush()
    return log
