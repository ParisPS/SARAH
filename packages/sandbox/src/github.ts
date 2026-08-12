import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { mkdir, readFile, rm } from "node:fs/promises";

/**
 * Credencial de CRIAÇÃO de repositório no GitHub — Fase 5 parte 3.
 *
 * Diferente da chave de deploy por projeto (`git-credential.ts`, usada
 * só pra `git push` num repositório que já existe), criar um
 * repositório novo é uma operação de CONTA (`POST /user/repos` da API
 * REST do GitHub) — uma chave de deploy SSH não serve pra isso: chaves
 * de deploy só existem DEPOIS que um repositório já existe (são
 * cadastradas nele, uma por uma, via `POST /repos/{owner}/{repo}/keys`),
 * e não dão acesso nenhum à API HTTP do GitHub. Confirmado antes de
 * implementar (não assumido) — ver docs/architecture.md, Fase 5 parte
 * 3, pra checagem feita: nem `gh` CLI está instalado nesta máquina,
 * nem existe token nenhum configurado ainda (Keychain vazio).
 *
 * Por isso esta é uma credencial NOVA e mais ampla, deliberadamente
 * separada da chave por projeto: um Personal Access Token clássico do
 * GitHub, escopo `repo` (checado na documentação oficial da REST API
 * antes de decidir — PAT "fine-grained" não tem suporte documentado
 * pra criar repositórios novos, só clássico tem `repo`/`public_repo`
 * confirmados pra `POST /user/repos`). Guardado no Keychain do macOS,
 * mesmo padrão já usado pro refresh token do Gmail e pra chave de
 * deploy por projeto — mas o ESCOPO de uso é bem mais restrito que o
 * do token em si: só o processo do DAEMON (nunca o container) lê esse
 * token, e só pra duas chamadas HTTP pontuais dentro de
 * `create_project` (criar o repo + cadastrar uma chave de deploy nova
 * pra ele) — o token em si NUNCA é escrito em disco dentro do
 * container nem passado pra dentro dele. Depois de criar o repo, o
 * fluxo de push continua usando a chave de deploy POR PROJETO de
 * sempre (auto-provisionada aqui, ver `provisionDeployKey`) — o token
 * de conta amplo não é necessário de novo depois da criação.
 */

const GITHUB_TOKEN_SERVICE = "sarah-code-github-token";
const API_BASE = "https://api.github.com";

function account(): string {
  return process.env.USER ?? userInfo().username;
}

function runSecurity(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("security", args);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (err) => resolve({ code: 1, stdout, stderr: String(err) }));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

/** `null` se nenhum token foi configurado ainda — estado padrão, não um erro. */
export async function getGithubToken(): Promise<string | null> {
  const { code, stdout } = await runSecurity(["find-generic-password", "-a", account(), "-s", GITHUB_TOKEN_SERVICE, "-w"]);
  if (code !== 0 || !stdout.trim()) return null;
  return stdout.trim();
}

function githubHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

/**
 * Valida o token de verdade (chamada real a `GET /user`) ANTES de
 * salvar — mesmo espírito do resto do projeto: nunca assumir que uma
 * credencial colada pelo usuário funciona sem testar. Devolve o login
 * do GitHub associado, pra confirmação legível no terminal.
 */
export async function saveGithubToken(token: string): Promise<{ login: string }> {
  const res = await fetch(`${API_BASE}/user`, { headers: githubHeaders(token) });
  if (!res.ok) {
    throw new Error(
      `Token do GitHub rejeitado (HTTP ${res.status}) — confira se colou certo e se o escopo "repo" foi marcado ` +
        `ao criar o token em https://github.com/settings/tokens.`
    );
  }
  const body = (await res.json()) as { login: string };

  const save = await runSecurity(["add-generic-password", "-a", account(), "-s", GITHUB_TOKEN_SERVICE, "-w", token, "-U"]);
  if (save.code !== 0) {
    throw new Error(`Falha ao salvar o token do GitHub no Keychain: ${save.stderr.trim() || "erro desconhecido"}`);
  }
  return { login: body.login };
}

export interface CreatedGithubRepo {
  owner: string;
  repo: string;
  sshUrl: string;
  htmlUrl: string;
  reused: boolean;
}

/**
 * Cria um repositório PRIVADO vazio (`auto_init: false` — nenhum
 * commit inicial do lado do GitHub, pra não conflitar com o `git
 * init` local já feito) pra este projeto. Se um repositório com esse
 * nome já existir NA CONTA DO PRÓPRIO usuário (ex.: projeto reaberto
 * numa sessão nova, depois do processo anterior morrer), reaproveita
 * em vez de falhar — mesmo espírito idempotente de `createProject`.
 */
export async function createGithubRepo(token: string, slug: string): Promise<CreatedGithubRepo> {
  const res = await fetch(`${API_BASE}/user/repos`, {
    method: "POST",
    headers: { ...githubHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({
      name: slug,
      private: true,
      description: "Projeto criado pela SARAH (sandbox de código, Fase 5).",
      auto_init: false,
    }),
  });

  if (res.status === 422) {
    // Nome já existe na conta — provavelmente o mesmo projeto sendo
    // reaberto. Busca o repo existente em vez de tratar como erro.
    const me = await fetch(`${API_BASE}/user`, { headers: githubHeaders(token) });
    const meBody = (await me.json()) as { login: string };
    const existing = await fetch(`${API_BASE}/repos/${meBody.login}/${slug}`, { headers: githubHeaders(token) });
    if (existing.ok) {
      const body = (await existing.json()) as { ssh_url: string; html_url: string; owner: { login: string }; name: string };
      return { owner: body.owner.login, repo: body.name, sshUrl: body.ssh_url, htmlUrl: body.html_url, reused: true };
    }
  }

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Falha ao criar o repositório "${slug}" no GitHub (HTTP ${res.status}): ${detail}`);
  }

  const body = (await res.json()) as { ssh_url: string; html_url: string; owner: { login: string }; name: string };
  return { owner: body.owner.login, repo: body.name, sshUrl: body.ssh_url, htmlUrl: body.html_url, reused: false };
}

/**
 * Gera um par de chaves ed25519 NOVO (via `ssh-keygen`, binário do
 * sistema — mesmo padrão de "chamar um binário do sistema" já usado
 * em todo o projeto) numa pasta temporária efêmera, cadastra a
 * pública como Deploy Key (`read_write: true`) no repositório recém-
 * criado, e devolve a privada pra ser guardada no Keychain do
 * projeto (`saveProjectDeployKey`, `git-credential.ts` — o mecanismo
 * de push já existente e testado, sem mudança nenhuma). Os arquivos
 * temporários são apagados logo depois de lidos, nunca ficam na pasta
 * do projeto nem em lugar nenhum persistido.
 */
export async function provisionDeployKey(token: string, owner: string, repo: string, slug: string): Promise<string> {
  const workDir = join(tmpdir(), `sarah-deploykey-${randomBytes(6).toString("hex")}`);
  const keyPath = join(workDir, "key");
  await mkdir(workDir, { recursive: true, mode: 0o700 });
  await new Promise<void>((resolve, reject) => {
    const child = spawn("ssh-keygen", ["-t", "ed25519", "-N", "", "-C", `sarah-${slug}`, "-f", keyPath]);
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ssh-keygen saiu com código ${code}`))));
  });

  try {
    const [privateKey, publicKey] = await Promise.all([readFile(keyPath, "utf-8"), readFile(`${keyPath}.pub`, "utf-8")]);

    const res = await fetch(`${API_BASE}/repos/${owner}/${repo}/keys`, {
      method: "POST",
      headers: { ...githubHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify({ title: `sarah-${slug}`, key: publicKey.trim(), read_write: true }),
    });
    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`Falha ao cadastrar a chave de deploy no repositório "${owner}/${repo}" (HTTP ${res.status}): ${detail}`);
    }

    return privateKey;
  } finally {
    // Best-effort: a pasta é temporária e efêmera de qualquer forma,
    // mas apaga explicitamente em vez de confiar só nisso.
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
