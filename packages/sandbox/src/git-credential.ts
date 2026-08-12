import { spawn } from "node:child_process";
import { userInfo } from "node:os";

/**
 * Credencial de `git push` por projeto — Fase 5 parte 1.
 *
 * Decisão tomada depois de testar (não assumir) a alternativa óbvia
 * ("encaminha o ssh-agent do usuário pro container"): NÃO FUNCIONA
 * nesta configuração. `SSH_AUTH_SOCK` do macOS aponta pra um socket em
 * `/var/run/com.apple.launchd.*` — fora de qualquer caminho
 * compartilhado por padrão entre o Mac e a VM do podman (só
 * `/Users`, `/private` e `/var/folders` são compartilhados via
 * virtiofs, conferido com `podman machine ssh -- mount`). Mesmo que
 * estivesse dentro de um caminho compartilhado, sockets Unix não
 * atravessam esse tipo de compartilhamento de arquivo entre kernels
 * diferentes (macOS vs. a VM Linux) — é uma limitação conhecida desse
 * tipo de virtualização, não um detalhe de configuração corrigível.
 *
 * Decisão adotada: mesmo padrão já usado pro refresh token do Gmail
 * (`packages/gmail/src/keychain.ts`) — uma credencial de deploy POR
 * PROJETO (não a identidade pessoal do usuário inteira) guardada no
 * Keychain do macOS, lida pelo processo do DAEMON (nunca pelo
 * container) e injetada dentro do container só no INSTANTE do push,
 * como um arquivo temporário na área efêmera do próprio container
 * (nunca na pasta do projeto montada, que é persistida no disco do
 * Mac) — apagado logo depois de usar. Escopo por projeto é
 * deliberado: se uma chave vazar, o dano fica limitado a UM
 * repositório, não à conta inteira do usuário.
 *
 * Nenhuma chave é configurada por esta fundação — só a mecânica.
 * `code.git_push` recusa com uma mensagem clara se nada foi
 * configurado ainda (ver `getProjectDeployKey`), consistente com "não
 * testa git_push com repositório real ainda" desta etapa.
 */

function servicePrefix(slug: string): string {
  return `sarah-code-deploy-key-${slug}`;
}

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

/** `null` se nenhuma chave foi configurada pra esse projeto ainda — não é um erro, é o estado padrão. */
export async function getProjectDeployKey(slug: string): Promise<string | null> {
  const { code, stdout } = await run("security", ["find-generic-password", "-a", account(), "-s", servicePrefix(slug), "-w"]);
  if (code !== 0 || !stdout.trim()) return null;
  return stdout;
}

export async function saveProjectDeployKey(slug: string, privateKeyPem: string): Promise<void> {
  const { code, stderr } = await run("security", [
    "add-generic-password",
    "-a",
    account(),
    "-s",
    servicePrefix(slug),
    "-w",
    privateKeyPem,
    "-U",
  ]);
  if (code !== 0) {
    throw new Error(`Falha ao salvar a chave de deploy do projeto "${slug}" no Keychain: ${stderr.trim() || "erro desconhecido"}`);
  }
}
