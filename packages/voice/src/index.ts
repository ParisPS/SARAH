import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Voz (Fase 4 parte 2) — STT (whisper.cpp) + TTS (`say` nativo do
 * macOS), plumbing pura de processo/áudio, SEM nenhuma dependência de
 * `@sarah/core`/Gateway/audit log. Isso é DE PROPÓSITO: gravar o
 * microfone e tocar uma resposta em voz alta são ações da INTERFACE
 * (`apps/menubar`), não uma tool que o agente decide chamar — não faz
 * sentido pelo Gateway de risco (ver `@sarah/permissions`), que
 * governa decisões do AGENTE, não UI local. `apps/menubar` importa
 * este pacote direto no processo do Electron (não no daemon filho).
 *
 * Todo o mecanismo aqui foi validado ISOLADO antes de escrever este
 * pacote (Fase 4 (Voz), primeira etapa — ver docs/architecture.md
 * pros achados reais, não hipotéticos, que levaram a cada decisão
 * abaixo):
 *
 * - STT: `whisper-cli` (Homebrew, `whisper-cpp`) com o modelo
 *   MULTILÍNGUE `ggml-small.bin` (não o `.en`-only) e `-l auto`
 *   (detecção automática de idioma — o usuário nunca escolhe o
 *   idioma de ENTRADA, só o de SAÍDA, via `speak()` abaixo).
 * - Gravação: `sox`/`rec`, não `whisper-stream` — o binário de
 *   streaming do próprio whisper.cpp trava no dispositivo de captura
 *   PADRÃO nesta máquina (provavelmente tenta o microfone de
 *   Continuidade do iPhone) e corrompe o áudio salvo se for morto com
 *   um sinal abrupto (SIGALRM/SIGKILL) — `sox`/`rec` finaliza o `.wav`
 *   de forma limpa com SIGINT, e sox tem embutido o efeito `silence`,
 *   que já resolve "parar sozinho depois de um período de silêncio"
 *   sem nenhum código extra de detecção de nível de áudio aqui.
 * - TTS: `say -v <voz>`, tocando direto nos alto-falantes (sem
 *   arquivo intermediário) — voz escolhida pelo IDIOMA DE SAÍDA
 *   (toggle da interface), independente do idioma que o usuário falou
 *   (isso é decidido pelo STT, autônomo).
 */

const HOME = homedir();

/**
 * Caminhos ABSOLUTOS dos binários, não nomes soltos confiando no
 * `PATH` — achado real: um app Electron lançado fora de um Terminal
 * (ex.: clique duplo, versão empacotada) pode ter um `PATH` mínimo do
 * macOS, sem `/opt/homebrew/bin` (onde o Homebrew instala em Apple
 * Silicon). Confirma o caminho típico de cada plataforma antes de
 * cair pro nome solto (que ainda funciona em dev via `pnpm --filter
 * menubar dev`, herdando o `PATH` do terminal que lançou o processo).
 */
function resolveBinary(names: string[], fallback: string): string {
  for (const candidate of names) {
    if (existsSync(candidate)) return candidate;
  }
  return fallback;
}

const WHISPER_CLI = resolveBinary(["/opt/homebrew/bin/whisper-cli", "/usr/local/bin/whisper-cli"], "whisper-cli");
const REC = resolveBinary(["/opt/homebrew/bin/rec", "/usr/local/bin/rec"], "rec");
const SAY = resolveBinary(["/usr/bin/say"], "say");

/**
 * Modelo multilíngue baixado fora do repositório (Fase 4 Voz, parte
 * 1) — mesmo espírito de nunca guardar credenciais/artefatos grandes
 * dentro do repo git: fica em `~/.cache/whisper-models/`, baixado uma
 * vez, reaproveitado por qualquer processo desta máquina. Configurável
 * via `SARAH_WHISPER_MODEL` só pra facilitar trocar de modelo sem
 * mexer em código (ex.: testar `medium` depois), nunca exigido.
 */
const WHISPER_MODEL = process.env.SARAH_WHISPER_MODEL ?? join(HOME, ".cache", "whisper-models", "ggml-small.bin");

export type OutputLanguage = "pt" | "en";

/** Vozes femininas confirmadas de verdade nesta máquina (`say -v '?'`) — não assumidas. */
const VOICE_BY_LANGUAGE: Record<OutputLanguage, string> = {
  pt: "Luciana",
  en: "Samantha",
};

export interface TranscribeResult {
  text: string;
  /** Código de idioma detectado pelo whisper (ex.: "pt", "en") — nunca escolhido pelo usuário. */
  language: string;
}

/**
 * Transcreve um arquivo de áudio já gravado. `-l auto`: detecção
 * automática de idioma, sempre — nunca hintado, mesmo sabendo o
 * idioma de saída selecionado (são independentes, ver topo do
 * arquivo). `-nt`: sem timestamps, só o texto corrido.
 */
export async function transcribe(audioPath: string): Promise<TranscribeResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(WHISPER_CLI, ["-m", WHISPER_MODEL, "-f", audioPath, "-l", "auto", "-nt"]);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk));
    child.on("error", (err) => reject(new Error(`Falha ao rodar whisper-cli: ${err.message}`)));
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`whisper-cli saiu com código ${code}: ${stderr.trim().slice(-500)}`));
        return;
      }
      // `whisper_full_with_state: auto-detected language: pt (p = 0.97)`
      // — sempre em stderr (mesma família de linhas de diagnóstico do
      // whisper.cpp, confirmado testando isolado, não assumido).
      const match = stderr.match(/auto-detected language:\s*([a-z]{2,3})/);
      const language = match ? match[1] : "unknown";
      resolve({ text: stdout.trim(), language });
    });
  });
}

/**
 * Fala um texto em voz alta, na voz certa pro idioma de SAÍDA
 * selecionado (toggle da interface) — sempre toca direto nos
 * alto-falantes (sem arquivo intermediário). Resolve só quando o
 * `say` termina de falar, pra quem chamar poder esperar antes de
 * liberar a interface pra um novo pedido (evita duas falas
 * sobrepostas).
 */
export async function speak(text: string, language: OutputLanguage): Promise<void> {
  const voice = VOICE_BY_LANGUAGE[language] ?? VOICE_BY_LANGUAGE.pt;
  return new Promise((resolve, reject) => {
    const child = spawn(SAY, ["-v", voice, text]);
    child.on("error", (err) => reject(new Error(`Falha ao rodar say: ${err.message}`)));
    child.on("close", () => resolve());
  });
}

export interface Recorder {
  /**
   * Para a gravação AGORA (clique de novo no microfone) — envia
   * SIGINT (não SIGKILL/SIGTERM: achado real, `sox`/`rec` só finaliza
   * o cabeçalho/dados do `.wav` direito com SIGINT). Seguro chamar
   * mesmo depois do processo já ter terminado sozinho (silêncio
   * detectado) — vira no-op.
   */
  stop(): void;
  /** Resolve quando a gravação termina, por QUALQUER motivo (silêncio detectado OU `stop()`). */
  finished: Promise<void>;
}

/**
 * Começa a gravar do microfone padrão do sistema pra `outPath`
 * (`.wav`, 16kHz mono — o formato que `whisper-cli` espera). Usa o
 * efeito `silence` do próprio sox pra parar sozinho depois de ~3s de
 * silêncio (`1 0.1 3% 1 3.0 3%`: início "imediato" assim que qualquer
 * som acima de 3% for detectado — na prática, ruído ambiente já basta,
 * então grava desde o clique — e fim automático depois de 3.0s
 * contínuos abaixo de 3%) — sem nenhum código próprio de detecção de
 * nível de áudio. `stop()` cobre o outro caminho pedido ("clique de
 * novo pra parar"), sem esperar o silêncio.
 */
export function startRecording(outPath: string): Recorder {
  const child = spawn(REC, ["-c", "1", "-r", "16000", outPath, "silence", "1", "0.1", "3%", "1", "3.0", "3%"]);

  const finished = new Promise<void>((resolve) => {
    child.on("close", () => resolve());
    child.on("error", () => resolve()); // erro ao spawnar: `finished` resolve mesmo assim, quem chamou confere o arquivo/resultado
  });

  return {
    stop() {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGINT");
      }
    },
    finished,
  };
}
