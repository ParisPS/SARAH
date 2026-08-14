import { spawn } from "node:child_process";

/**
 * Abre uma URL `facetime://` de verdade via `open` (utilitário nativo
 * do macOS, sem dependência nova) — o mesmo mecanismo que o Finder usa
 * ao abrir qualquer link/arquivo, aqui apontado pro esquema `facetime:`
 * que o app FaceTime já registra sozinho. `open` só INSTRUI o macOS a
 * abrir a URL com o handler registrado — não é um shell arbitrário
 * (sem risco de injeção: o alvo vira UM argumento de array pro
 * `spawn`, nunca concatenado numa string de shell).
 *
 * DECISÃO CRÍTICA, testada e confirmada antes de escrever isto:
 * `facetime://` inicia uma chamada de VÍDEO; `facetime-audio://` é o
 * esquema SEPARADO pra áudio. Este arquivo só usa `facetime://` —
 * nunca o de áudio — porque o pedido explícito da Fase 8 foi vídeo.
 */
const FACETIME_VIDEO_SCHEME = "facetime://";

export function openFaceTimeVideoCall(target: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const url = FACETIME_VIDEO_SCHEME + encodeURIComponent(target);
    const child = spawn("open", [url]);

    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (err) => {
      reject(new Error(`Falha ao iniciar \`open\`: ${err.message}`));
    });

    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`\`open ${url}\` saiu com código ${code}. stderr: ${stderr.trim() || "(vazio)"}`));
        return;
      }
      resolve();
    });
  });
}
