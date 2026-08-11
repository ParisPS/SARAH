import { spawn } from "node:child_process";
import { userInfo } from "node:os";

/**
 * Guarda o refresh token do Gmail no Keychain do macOS via o binário
 * `security` — mesmo espírito de "chamar um binário do sistema via
 * child_process e tratar stdout/stderr" já usado no bridge JXA do
 * EventKit (packages/apple-calendar/src/bridge.ts). Nunca grava o
 * token em nenhum arquivo do repo (nem `.env`).
 */
const SERVICE_NAME = "sarah-gmail-refresh-token";

function account(): string {
  return process.env.USER ?? userInfo().username;
}

function run(command: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

export async function getRefreshToken(): Promise<string> {
  const { code, stdout } = await run("security", [
    "find-generic-password",
    "-a",
    account(),
    "-s",
    SERVICE_NAME,
    "-w",
  ]);
  if (code !== 0 || !stdout.trim()) {
    throw new Error(
      "Nenhum refresh token do Gmail encontrado no Keychain. Rode `pnpm gmail:auth` " +
        "pra autorizar a SARAH a acessar seu Gmail (abre o navegador pra login/consentimento)."
    );
  }
  return stdout.trim();
}

export async function saveRefreshToken(token: string): Promise<void> {
  const { code, stderr } = await run("security", [
    "add-generic-password",
    "-a",
    account(),
    "-s",
    SERVICE_NAME,
    "-w",
    token,
    "-U", // atualiza o item se já existir, em vez de dar erro "already exists"
  ]);
  if (code !== 0) {
    throw new Error(`Falha ao salvar o refresh token do Gmail no Keychain: ${stderr.trim() || "erro desconhecido"}`);
  }
}
