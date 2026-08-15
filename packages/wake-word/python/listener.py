"""
Escuta contínua (Fase 10) — processo Python de vida longa, separado do
resto da SARAH (Node/TypeScript) porque openWakeWord (detecção de
wake-word em tempo real) é uma biblioteca Python, sem porte pra
Node/JS. Mesmo espírito de sempre deste projeto: chamar um processo
externo especializado via stdio, em vez de reimplementar algo que já
existe pronto (ver `packages/apple-calendar` JXA, `packages/voice`
whisper-cli/sox).

Responsabilidade ÚNICA deste script: ficar ouvindo o microfone e
avisar (uma linha JSON por stdout) quando um dos gatilhos disparar —
NUNCA decide o que fazer depois disso (gravar, mandar pro agente,
etc.) — isso é responsabilidade do processo principal do Electron
(`packages/wake-word/src/index.ts` → `apps/menubar/src/main-process.ts`),
mesma separação de responsabilidade já usada em todo o projeto (ex.:
o Gateway de permissões nunca sabe de UI).

Protocolo stdout (uma linha JSON por evento, SEMPRE só isso em
stdout — qualquer log/diagnóstico vai pra stderr, pra não poluir o
parsing linha-a-linha do lado Node):
  {"event": "ready"}                    — stream de áudio abriu com sucesso
  {"event": "wake", "score": 0.99}      — wake-word detectada
  {"event": "clap"}                     — duas palmas seguidas detectadas
  {"event": "speech", "score": 0.87}    — voz do usuário detectada (só
                                           relevante pro barge-in opcional,
                                           ver docs/architecture.md)
  {"event": "error", "message": "..."}  — erro fatal, processo vai sair em seguida
"""

import argparse
import os
import time

import numpy as np
import sounddevice as sd

from audio_common import SAMPLE_RATE, CHUNK_SAMPLES, emit, make_logger

log = make_logger("listener.py")

# --- gatilho 1: wake-word (openWakeWord) ------------------------------

WAKE_COOLDOWN_S = 2.0  # depois de disparar, ignora novas detecções por este tempo (evita reativar na cauda da própria fala "SARAH")

# --- gatilho 2: duas palmas seguidas (amplitude, sem ML) ---------------
# Palma é um transiente CURTO e muito mais alto que o ruído ambiente —
# detectado comparando o pico de CADA frame de 80ms com uma média móvel
# do "chão" de ruído recente (atualizada só com frames QUIETOS, pra um
# clap não contaminar a própria média que serviria de referência pra
# detectar ele mesmo).
CLAP_ABS_FLOOR = 0.18       # pico mínimo (0-1) pra sequer considerar candidato a palma — evita disparar em silêncio/ruído baixo
CLAP_RELATIVE_MULT = 5.0    # pico precisa ser N vezes o ruído ambiente médio
CLAP_REFRACTORY_S = 0.15    # tempo mínimo entre duas detecções de palma INDIVIDUAL (evita contar a cauda/eco da mesma palma como uma segunda)
CLAP_PAIR_MIN_GAP_S = 0.10  # menor intervalo aceitável entre a 1ª e a 2ª palma do par
CLAP_PAIR_MAX_GAP_S = 0.80  # maior intervalo aceitável — depois disso, a 1ª palma "expira" e uma nova candidata vira a "1ª" de um par novo
CLAP_COOLDOWN_S = 2.0

# --- barge-in (opcional, ver Node) — Silero VAD já embutido no openWakeWord
SPEECH_THRESHOLD = 0.6
SPEECH_EMIT_INTERVAL_S = 0.1  # limita a taxa de eventos "speech" (o Node agrega vários pra decidir interromper, não precisa de um por frame)


def resolve_wakeword_model(model_arg: str) -> tuple[str, str]:
    """
    Devolve (referência pro openWakeWord, chave esperada no dict de
    predições). Se `model_arg` for um caminho de arquivo real (modelo
    customizado, ex.: um "sarah.onnx" treinado via Colab — ver
    docs/architecture.md), usa o caminho e deriva a chave do nome do
    arquivo (mesma convenção que o próprio openWakeWord usa
    internamente). Caso contrário, trata como nome de modelo PRONTO
    (ex.: "hey_jarvis", o placeholder usado até o modelo customizado
    "SARAH" existir).
    """
    if os.path.exists(model_arg):
        key = os.path.splitext(os.path.basename(model_arg))[0]
        return model_arg, key
    return model_arg, model_arg


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--model",
        default=os.environ.get("SARAH_WAKEWORD_MODEL", "hey_jarvis"),
        help="Nome de um modelo pronto do openWakeWord OU caminho pra um .onnx/.tflite customizado.",
    )
    parser.add_argument("--threshold", type=float, default=0.5)
    parser.add_argument("--barge-in", action="store_true", help="Também emite eventos 'speech' (VAD) pro barge-in opcional.")
    args = parser.parse_args()

    try:
        from openwakeword.model import Model
        from openwakeword.vad import VAD
    except ImportError as err:
        emit({"event": "error", "message": f"openwakeword não instalado no venv: {err}. Rode `pnpm wake-word:setup`."})
        sys.exit(1)

    model_ref, model_key = resolve_wakeword_model(args.model)
    log(f"carregando modelo de wake-word: {model_ref} (chave esperada: {model_key})")
    try:
        oww = Model(wakeword_models=[model_ref], inference_framework="onnx")
    except Exception as err:
        emit({"event": "error", "message": f"falha carregando modelo de wake-word '{model_ref}': {err}"})
        sys.exit(1)

    # Confirma que a chave que vamos consultar em cada predict() bate
    # com o que o openWakeWord de fato registrou — acontece de o nome
    # resolvido internamente diferir sutilmente (ex.: espaço vs
    # underscore). Falha alto e claro agora, não silenciosamente
    # sempre lendo score 0.0 depois.
    if model_key not in oww.models:
        emit({
            "event": "error",
            "message": f"modelo carregado mas chave '{model_key}' não apareceu em oww.models (chaves reais: {list(oww.models.keys())}).",
        })
        sys.exit(1)

    vad = VAD() if args.barge_in else None

    ambient = 0.02  # estimativa inicial de ruído de fundo, se ajusta sozinha nos primeiros frames
    last_single_clap_t = 0.0
    last_clap_fire_t = 0.0
    last_wake_fire_t = 0.0
    last_speech_emit_t = 0.0

    def audio_callback(indata, frames, time_info, status):
        nonlocal ambient, last_single_clap_t, last_clap_fire_t, last_wake_fire_t, last_speech_emit_t
        if status:
            log(f"status do stream: {status}")

        frame = indata[:, 0]
        now = time.monotonic()

        # --- wake-word ---------------------------------------------
        prediction = oww.predict(frame)
        score = float(prediction.get(model_key, 0.0))
        if score >= args.threshold and (now - last_wake_fire_t) > WAKE_COOLDOWN_S:
            last_wake_fire_t = now
            emit({"event": "wake", "score": round(score, 3)})

        # --- palmas ---------------------------------------------------
        peak = float(np.abs(frame).max()) / 32768.0
        is_clap_candidate = peak > CLAP_ABS_FLOOR and peak > ambient * CLAP_RELATIVE_MULT
        if not is_clap_candidate:
            # só atualiza o "chão" de ruído com frames QUIETOS — um
            # frame de fala normal (mais alto que ambiente, mas não
            # candidato a palma) ainda pode enviesar a média pra cima
            # aos poucos; isso é aceitável (aumenta o piso, exige palma
            # mais alta) e evita o problema pior (chão nunca sobe e
            # qualquer ruído vira "palma").
            ambient = ambient * 0.98 + peak * 0.02
        elif (now - last_single_clap_t) > CLAP_REFRACTORY_S:
            gap = now - last_single_clap_t
            if CLAP_PAIR_MIN_GAP_S <= gap <= CLAP_PAIR_MAX_GAP_S and (now - last_clap_fire_t) > CLAP_COOLDOWN_S:
                last_clap_fire_t = now
                last_single_clap_t = 0.0  # consome o par, não deixa a 2ª palma virar "1ª" de um par seguinte por acidente
                emit({"event": "clap"})
            else:
                last_single_clap_t = now

        # --- barge-in (opcional) ---------------------------------------
        if vad is not None:
            vad.predict(frame, frame_size=CHUNK_SAMPLES)
            vad_score = float(vad.prediction_buffer[-1]) if vad.prediction_buffer else 0.0
            if vad_score >= SPEECH_THRESHOLD and (now - last_speech_emit_t) > SPEECH_EMIT_INTERVAL_S:
                last_speech_emit_t = now
                emit({"event": "speech", "score": round(vad_score, 3)})

    try:
        with sd.InputStream(
            samplerate=SAMPLE_RATE,
            channels=1,
            dtype="int16",
            blocksize=CHUNK_SAMPLES,
            callback=audio_callback,
        ):
            emit({"event": "ready"})
            log("escutando continuamente — Ctrl+C ou SIGTERM pra sair")
            while True:
                time.sleep(0.5)
    except KeyboardInterrupt:
        pass
    except Exception as err:
        emit({"event": "error", "message": f"stream de áudio falhou: {err}"})
        sys.exit(1)


if __name__ == "__main__":
    main()
