"""
Fim de fala por silêncio (Fase 10, ajuste pedido depois do primeiro
teste real da escuta contínua: "hoje ainda precisa clicar no
microfone pra encerrar — isso deveria ser automático"). Processo
Python de vida CURTA — nasce quando uma gravação começa
(`sarah:startRecording`, ver main-process.ts) e morre sozinho assim
que detectar fala-seguida-de-silêncio (ou é morto pelo Node se a
gravação já tiver terminado por outro caminho, ex.: clique manual no
microfone).

Mesma família de análise que `listener.py` usa pra detectar palmas
(amplitude do frame ao longo do tempo, sem biblioteca de reconhecimento
de fala nenhuma) — reaproveita `audio_common.py`, só a LÓGICA em cima
do nível de áudio é diferente: em vez de procurar um transiente CURTO
e muito mais alto que o ambiente (palma), procura fala (nível acima de
um limiar por um tempo qualquer) seguida de SILÊNCIO SUSTENTADO.

Protocolo stdout (só um evento, e o processo sai logo em seguida):
  {"event": "silence_timeout", "reason": "silence", "speech_ms": 4230, "silence_ms": 1800}
  {"event": "silence_timeout", "reason": "max_duration"}   — rede de segurança, ver MAX_RECORDING_S
  {"event": "error", "message": "..."}
"""

import time

import numpy as np
import sounddevice as sd

from audio_common import SAMPLE_RATE, CHUNK_SAMPLES, emit, make_logger

log = make_logger("silence_watcher.py")

# Limiar de fala ADAPTATIVO (relativo ao ruído ambiente), mesmo
# princípio da detecção de palma em `listener.py` — mas bem menos
# exigente: fala normal é bem mais sutil que uma palma, não é um
# transiente isolado. `SPEECH_RELATIVE_MULT` menor (2.2x, contra 5x
# de palma) porque queremos capturar fala normal, não só picos.
SPEECH_ABS_FLOOR = 0.03
SPEECH_RELATIVE_MULT = 2.2

# Pedido explícito: ~1.5-2s de silêncio contínuo DEPOIS de já ter
# ouvido fala de verdade (nunca conta o silêncio ANTES da pessoa
# começar a falar, senão encerraria imediatamente toda gravação que
# começa com uma pausa natural pra pensar).
SILENCE_DURATION_S = 1.8

# Rede de segurança — se por algum motivo nunca detectar "fala" nem
# "silêncio sustentado" (ex.: ruído constante no limiar, sem nunca
# ficar quieto o bastante), não trava a gravação pra sempre. Bem acima
# de qualquer resposta razoável, só existe pra nunca deixar o usuário
# preso numa gravação que nem o clique manual salvaria de esperar.
MAX_RECORDING_S = 60.0


def main() -> None:
    ambient = 0.02
    has_spoken = False
    speech_started_at = None
    silence_started_at = None
    start_time = time.monotonic()

    def audio_callback(indata, frames, time_info, status):
        nonlocal ambient, has_spoken, speech_started_at, silence_started_at
        if status:
            log(f"status do stream: {status}")

        frame = indata[:, 0]
        now = time.monotonic()

        if now - start_time > MAX_RECORDING_S:
            emit({"event": "silence_timeout", "reason": "max_duration"})
            raise sd.CallbackStop()

        peak = float(np.abs(frame).max()) / 32768.0
        is_speech = peak > max(SPEECH_ABS_FLOOR, ambient * SPEECH_RELATIVE_MULT)

        if is_speech:
            if not has_spoken:
                has_spoken = True
                speech_started_at = now
                log(f"fala detectada em t={now - start_time:.2f}s")
            silence_started_at = None  # ainda falando — reseta qualquer contagem de silêncio em andamento
        else:
            ambient = ambient * 0.98 + peak * 0.02
            if has_spoken:
                if silence_started_at is None:
                    silence_started_at = now
                elif now - silence_started_at >= SILENCE_DURATION_S:
                    emit({
                        "event": "silence_timeout",
                        "reason": "silence",
                        "speech_ms": round((silence_started_at - speech_started_at) * 1000),
                        "silence_ms": round((now - silence_started_at) * 1000),
                    })
                    raise sd.CallbackStop()

    try:
        with sd.InputStream(
            samplerate=SAMPLE_RATE,
            channels=1,
            dtype="int16",
            blocksize=CHUNK_SAMPLES,
            callback=audio_callback,
        ) as stream:
            log("monitorando nível de áudio pra detectar fim de fala...")
            while stream.active:
                time.sleep(0.05)
    except Exception as err:
        emit({"event": "error", "message": f"stream de áudio falhou: {err}"})


if __name__ == "__main__":
    main()
