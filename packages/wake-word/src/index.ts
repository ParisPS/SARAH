import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as readline from "node:readline";

/**
 * Escuta contínua (Fase 10) — wrapper fino em volta do processo Python
 * de vida longa (`python/listener.py`, ver o arquivo pra o mecanismo
 * completo: openWakeWord pra wake-word, amplitude pra palmas, Silero
 * VAD pro barge-in opcional). Mesmo princípio de `@sarah/voice`: isto
 * é plumbing de CAPTURA DE ÁUDIO da interface, não uma tool do agente
 * — não passa pelo Gateway/`@sarah/core` (ver `@sarah/permissions`),
 * `apps/menubar` importa este pacote direto no processo do Electron.
 *
 * Viabilidade CONFIRMADA rodando de verdade nesta máquina antes de
 * integrar (não assumida): openWakeWord detecta em tempo real via
 * ONNX Runtime no Apple Silicon, sem travar, com scores >0.99 pra uma
 * wake-word real dita em voz alta (ver docs/architecture.md, Fase 10,
 * pro log real do teste isolado).
 *
 * Achado real: `pip install` direto no Python do Homebrew falha com
 * "externally-managed-environment" (PEP 668) — corrigido com um venv
 * ISOLADO em `packages/wake-word/.venv` (nunca comitado, ver
 * `.gitignore`), criado via `pnpm wake-word:setup`
 * (`scripts/wake-word-setup.sh`).
 */

const HERE = dirname(fileURLToPath(import.meta.url));
// `src/` -> sobe 1 nível -> raiz do pacote `packages/wake-word`.
const PACKAGE_ROOT = join(HERE, "..");
const VENV_PYTHON = join(PACKAGE_ROOT, ".venv", "bin", "python");
const LISTENER_SCRIPT = join(PACKAGE_ROOT, "python", "listener.py");

export type VoiceTriggerEvent =
  | { type: "wake"; score: number }
  | { type: "clap" }
  | { type: "speech"; score: number };

export interface ContinuousListenerOptions {
  /**
   * Nome de um modelo PRONTO do openWakeWord (ex.: "hey_jarvis",
   * placeholder atual — ver docs/architecture.md) OU caminho absoluto
   * pra um modelo customizado (ex.: "sarah.onnx", depois de treinado
   * via Colab). Padrão: variável de ambiente `SARAH_WAKEWORD_MODEL`,
   * ou "hey_jarvis" se nem essa existir.
   */
  model?: string;
  /** 0-1, padrão 0.5 — mesmo padrão recomendado pela doc do openWakeWord. */
  threshold?: number;
  /**
   * Emite também eventos `{type: "speech"}` (Silero VAD) — só usado
   * pelo barge-in opcional (ver `apps/menubar/renderer/renderer.js`).
   * Custo de CPU adicional é pequeno (VAD já vem embutido no
   * openWakeWord), mas fica atrás de uma flag mesmo assim: quem não
   * ligou o barge-in não precisa nem desse processamento extra rodando.
   */
  bargeIn?: boolean;
  onEvent: (event: VoiceTriggerEvent) => void;
  /** Erro FATAL (processo Python não iniciou, ou morreu sozinho) — nunca chamado pra erro recuperável. */
  onError: (message: string) => void;
}

export interface ContinuousListener {
  /** Mata o processo Python (SIGTERM — o script trata e sai limpo). Seguro chamar mais de uma vez. */
  stop(): void;
}

/**
 * Checa se o venv já foi criado (`pnpm wake-word:setup`) — checagem
 * BARATA (só `existsSync`, sem rodar nada) que `startContinuousListening`
 * faz antes de tentar spawnar, pra devolver uma mensagem de erro clara
 * (`onError`) em vez do erro genérico "ENOENT" que `spawn` daria pro
 * binário do venv que não existe.
 */
export function isWakeWordSetUp(): boolean {
  return existsSync(VENV_PYTHON) && existsSync(LISTENER_SCRIPT);
}

/**
 * Começa a escutar continuamente. Devolve na hora (não espera o
 * primeiro evento) — quem chamar sabe que o stream de áudio abriu de
 * verdade quando `onEvent` receber... na prática não emitimos "ready"
 * como um `VoiceTriggerEvent` pro chamador (é só um sinal interno de
 * diagnóstico, ver stderr/log) — o contrato público é só os três
 * tipos de evento que importam pra UI.
 */
export function startContinuousListening(options: ContinuousListenerOptions): ContinuousListener {
  if (!isWakeWordSetUp()) {
    options.onError("Escuta contínua não configurada — rode `pnpm wake-word:setup` uma vez (cria o venv Python e baixa os modelos).");
    return { stop() {} };
  }

  const args = [
    LISTENER_SCRIPT,
    "--model",
    options.model ?? process.env.SARAH_WAKEWORD_MODEL ?? "hey_jarvis",
    "--threshold",
    String(options.threshold ?? 0.5),
  ];
  if (options.bargeIn) args.push("--barge-in");

  const child: ChildProcess = spawn(VENV_PYTHON, args);
  let stopped = false;

  // Uma linha JSON por evento (ver protocolo documentado no topo de
  // `listener.py`) — `readline` já cuida de acumular/quebrar por `\n`,
  // não precisa de buffer manual aqui.
  const rl = readline.createInterface({ input: child.stdout! });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let parsed: { event?: string; score?: number; message?: string };
    try {
      parsed = JSON.parse(line);
    } catch {
      return; // linha não-JSON (não deveria acontecer — stdout é só pra eventos) — ignora, não derruba a escuta
    }
    if (parsed.event === "wake") {
      options.onEvent({ type: "wake", score: typeof parsed.score === "number" ? parsed.score : 0 });
    } else if (parsed.event === "clap") {
      options.onEvent({ type: "clap" });
    } else if (parsed.event === "speech") {
      options.onEvent({ type: "speech", score: typeof parsed.score === "number" ? parsed.score : 0 });
    } else if (parsed.event === "error") {
      options.onError(parsed.message ?? "Erro desconhecido no processo de escuta contínua.");
    }
    // "ready" só é log/diagnóstico — sem ação nenhuma do lado Node.
  });

  child.stderr?.on("data", (chunk: Buffer) => {
    console.log(`[wake-word] ${chunk.toString().trim()}`);
  });

  child.on("error", (err) => {
    options.onError(`Falha ao iniciar o processo de escuta contínua: ${err.message}`);
  });

  child.on("close", (code) => {
    // Saída LIMPA (`stop()` chamado, ou SIGTERM) não é erro — só uma
    // saída com código != 0 e sem ter sido pedida por nós é uma queda
    // real que quem chamou precisa saber (pra desligar o toggle na UI).
    if (!stopped && code !== 0 && code !== null) {
      options.onError(`Processo de escuta contínua encerrou sozinho (código ${code}).`);
    }
  });

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      rl.close();
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
      }
    },
  };
}
