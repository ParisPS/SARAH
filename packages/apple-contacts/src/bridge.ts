import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BRIDGE_SCRIPT_PATH = join(__dirname, "..", "native", "contacts-bridge.js");

const BRIDGE_TIMEOUT_MS = 15_000;

/**
 * Idêntico a packages/apple-notes/src/bridge.ts (mesmo protocolo:
 * spawn de `osascript -l JavaScript`, JSON pelo stdin/stdout) — só o
 * script apontado é diferente.
 */
export function runContactsBridge(command: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn("osascript", ["-l", "JavaScript", BRIDGE_SCRIPT_PATH]);

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`Timeout (${BRIDGE_TIMEOUT_MS}ms) esperando resposta da ponte Contacts (osascript).`));
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
        reject(new Error(`Ponte Contacts (osascript) saiu com código ${code}. stderr: ${stderr.trim() || "(vazio)"}`));
        return;
      }

      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error(`Ponte Contacts devolveu saída que não é JSON válido: ${stdout.trim() || "(vazio)"}`));
      }
    });

    child.stdin.write(JSON.stringify(command));
    child.stdin.end();
  });
}
