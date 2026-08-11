import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BRIDGE_SCRIPT_PATH = join(__dirname, "..", "native", "eventkit-bridge.js");

const BRIDGE_TIMEOUT_MS = 15_000;

/**
 * Chama o helper JXA (`native/eventkit-bridge.js`) como subprocess,
 * trocando JSON pelo stdin/stdout — mesmo padrão pedido originalmente
 * pra uma ponte Swift, só que via `osascript -l JavaScript` em vez de
 * um binário compilado (ver comentário no topo do próprio script JXA
 * e docs/architecture.md pro porquê).
 *
 * O script JXA sempre imprime `{ ok: boolean, ... }` no stdout, mesmo
 * em erros esperados (ex.: acesso ao Calendário negado) — então aqui
 * a gente só precisa lidar com falhas de infraestrutura: processo que
 * não roda, timeout, ou stdout que não é JSON válido.
 */
export function runEventKitBridge(command: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn("osascript", ["-l", "JavaScript", BRIDGE_SCRIPT_PATH]);

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(
        new Error(
          `Timeout (${BRIDGE_TIMEOUT_MS}ms) esperando resposta da ponte EventKit (osascript).`
        )
      );
    }, BRIDGE_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`Falha ao iniciar osascript: ${err.message}`));
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      if (code !== 0) {
        reject(
          new Error(
            `Ponte EventKit (osascript) saiu com código ${code}. stderr: ${stderr.trim() || "(vazio)"}`
          )
        );
        return;
      }

      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(
          new Error(
            `Ponte EventKit devolveu saída que não é JSON válido: ${stdout.trim() || "(vazio)"}`
          )
        );
      }
    });

    child.stdin.write(JSON.stringify(command));
    child.stdin.end();
  });
}
