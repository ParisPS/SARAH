import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BRIDGE_SCRIPT_PATH = join(__dirname, "..", "native", "eventkit-bridge.js");

const BRIDGE_TIMEOUT_MS = 15_000;

/**
 * Idêntico a packages/apple-calendar/src/bridge.ts — chama o helper
 * JXA como subprocess, JSON pelo stdin/stdout. Ver o comentário lá
 * pro raciocínio completo (JXA em vez de Swift compilado).
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
