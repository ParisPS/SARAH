import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { mkdir, writeFile as fsWriteFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import {
  podman,
  createProjectContainer,
  stopProjectContainer,
  cleanupOrphanedContainers,
  checkPodmanAvailable,
  PREVIEW_CONTAINER_PORT,
  type ExecResult,
} from "./podman.js";
import { getProjectDeployKey } from "./git-credential.js";

/**
 * Ciclo de vida do container por projeto (Fase 5 parte 1 — decisão que
 * faltava na fundação, resolvida aqui):
 *
 * - Criado sob demanda na primeira chamada de qualquer `code.*` pra um
 *   projeto (`code.create_project`), e mantido rodando enquanto o
 *   projeto está "aberto" — cada chamada seguinte usa `podman exec`
 *   nele (evita o custo de subir/derrubar container a cada
 *   escrita/comando).
 * - Encerrado por DOIS gatilhos, sem um terceiro "fechar projeto"
 *   explícito (fora de escopo desta etapa, não pedido):
 *   1. Fim da sessão da SARAH (`stopAllProjects()`, chamado de
 *      `SarahSession.close()` em @sarah/core — mesmo lugar que já
 *      fecha o audit log e a memória) — encerramento limpo, todos os
 *      containers de projeto ativos param junto.
 *   2. Inatividade: nenhuma chamada `code.*` pra aquele projeto por
 *      `IDLE_TIMEOUT_MS` (30 minutos) — um `setInterval` confere
 *      periodicamente e derruba containers ociosos sozinho. Existe
 *      pra sessões muito longas (o daemon do `apps/menubar` pode
 *      ficar de pé por horas/dias) não acumularem containers
 *      reservando CPU/memória indefinidamente se o usuário esquecer
 *      um projeto aberto.
 * - Um container nunca é reaproveitado entre projetos diferentes —
 *   cada um tem seu próprio nome (`sarah-proj-<slug>`) e morre com
 *   `--rm` quando é parado.
 */
const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Pastas de projeto ficam FORA do repositório da SARAH, de propósito
 * — repetir o padrão de `packages/`/`data/` recriaria exatamente o
 * problema já registrado no CLAUDE.md ("Escopo do repositório git —
 * cuidado": um repo git aninhado dentro de outro, por acidente, uma
 * vez já). `~/SarahProjects/<slug>/` é uma pasta IRMÃ de
 * `Developer/jarvis`, cada uma com seu próprio `.git` — nunca dentro
 * da árvore deste repositório.
 */
const PROJECTS_ROOT = join(homedir(), "SarahProjects");

interface ProjectRuntime {
  slug: string;
  name: string;
  hostDir: string;
  containerName: string;
  previewHostPort: number;
  lastUsedAt: number;
}

const projects = new Map<string, ProjectRuntime>();
let podmanChecked = false;

function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // remove marcas combinantes (acentos) depois do NFD
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) throw new Error(`Nome de projeto inválido: "${name}" — precisa ter pelo menos uma letra/número.`);
  return slug;
}

function runHost(command: string, args: string[], cwd: string): Promise<ExecResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (err) => resolvePromise({ code: 1, stdout, stderr: String(err) }));
    child.on("close", (code) => resolvePromise({ code: code ?? 1, stdout, stderr }));
  });
}

/**
 * Confirma que o runtime (podman) está disponível ANTES de tentar criar
 * qualquer container — uma vez por processo, não a cada chamada. Erro
 * aqui é claro e acionável, não um stack trace de `spawn ENOENT`.
 */
async function ensurePodmanReady(): Promise<void> {
  if (podmanChecked) return;
  const status = await checkPodmanAvailable();
  if (!status.available) {
    throw new Error(`Sandbox de código indisponível: ${status.detail}`);
  }
  await cleanupOrphanedContainers();
  podmanChecked = true;
}

export async function createProject(name: string): Promise<{ slug: string; hostDir: string; alreadyExisted: boolean }> {
  await ensurePodmanReady();
  const slug = slugify(name);

  const existing = projects.get(slug);
  if (existing) {
    existing.lastUsedAt = Date.now();
    return { slug, hostDir: existing.hostDir, alreadyExisted: true };
  }

  const hostDir = join(PROJECTS_ROOT, slug);
  await mkdir(hostDir, { recursive: true });

  // git init só se ainda não for um repo (idempotente — projeto pode
  // já existir de uma sessão anterior).
  await runHost("git", ["init"], hostDir);
  const gitUser = await runHost("git", ["config", "--global", "user.name"], hostDir);
  const gitEmail = await runHost("git", ["config", "--global", "user.email"], hostDir);
  if (gitUser.stdout.trim()) await runHost("git", ["config", "user.name", gitUser.stdout.trim()], hostDir);
  if (gitEmail.stdout.trim()) await runHost("git", ["config", "user.email", gitEmail.stdout.trim()], hostDir);

  const container = await createProjectContainer(slug, hostDir);

  projects.set(slug, {
    slug,
    name,
    hostDir,
    containerName: container.name,
    previewHostPort: container.previewHostPort,
    lastUsedAt: Date.now(),
  });

  return { slug, hostDir, alreadyExisted: false };
}

function requireProject(projectSlug: string): ProjectRuntime {
  const slug = slugify(projectSlug);
  const runtime = projects.get(slug);
  if (!runtime) {
    throw new Error(`Projeto "${projectSlug}" não está aberto nesta sessão. Use code.create_project primeiro.`);
  }
  runtime.lastUsedAt = Date.now();
  return runtime;
}

/**
 * Escreve DIRETO no host (não via `podman exec`) — `/workspace` dentro
 * do container é literalmente `hostDir` montado, então escrever de um
 * lado ou outro dá o mesmo resultado, e fazer pelo host evita o
 * overhead de entrar no container só pra um `cat > arquivo`.
 * `relPath` é validado duas vezes: rejeita ".."/caminho absoluto de
 * cara (mensagem de erro melhor), e reconfirma depois de resolver o
 * caminho que ele continua DENTRO de `hostDir` (a checagem que
 * realmente importa — a primeira é só uma rejeição mais cedo/clara).
 */
export async function writeProjectFile(projectSlug: string, relPath: string, content: string): Promise<string> {
  const runtime = requireProject(projectSlug);
  if (relPath.startsWith("/") || relPath.includes("..")) {
    throw new Error(`Caminho inválido: "${relPath}" — precisa ser relativo à raiz do projeto, sem ".." nem começar com "/".`);
  }
  const root = resolve(runtime.hostDir);
  const target = resolve(root, relPath);
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error(`Caminho "${relPath}" tentou sair da pasta do projeto — bloqueado.`);
  }
  await mkdir(dirname(target), { recursive: true });
  await fsWriteFile(target, content, "utf-8");
  return target;
}

export async function runProjectCommand(projectSlug: string, command: string, timeoutSeconds = 120): Promise<ExecResult> {
  const runtime = requireProject(projectSlug);
  return podman(["exec", runtime.containerName, "sh", "-c", command], { timeoutMs: timeoutSeconds * 1000 });
}

/**
 * `-m`/`-a` passados como argv separado (nunca interpolados numa
 * string de shell) — evita que uma mensagem de commit com `$(...)` ou
 * crase seja interpretada como comando pelo shell dentro do container.
 * `run_command` (acima) PRECISA de um shell de verdade (é o propósito
 * dele); `git_commit` não precisa, então não usa um.
 */
export async function gitCommit(projectSlug: string, message: string): Promise<ExecResult> {
  const runtime = requireProject(projectSlug);
  const add = await podman(["exec", runtime.containerName, "git", "add", "-A"]);
  if (add.code !== 0) return add;
  return podman(["exec", runtime.containerName, "git", "commit", "-m", message]);
}

export interface GitPushResult extends ExecResult {
  skipped?: string;
}

export async function gitPush(projectSlug: string, remote: string, branch: string, force: boolean): Promise<GitPushResult> {
  const runtime = requireProject(projectSlug);
  const key = await getProjectDeployKey(runtime.slug);
  if (!key) {
    return {
      code: 1,
      stdout: "",
      stderr: "",
      skipped:
        `Nenhuma credencial de git configurada pro projeto "${runtime.slug}" ainda. ` +
        "Peça ao usuário pra configurar uma chave de deploy (Keychain) antes de tentar de novo.",
    };
  }

  const keyPath = "/tmp/.sarah_deploy_key";
  const writeKey = await podman(["exec", "-i", runtime.containerName, "sh", "-c", `cat > ${keyPath} && chmod 600 ${keyPath}`], {
    input: key,
  });
  if (writeKey.code !== 0) {
    return { code: writeKey.code, stdout: writeKey.stdout, stderr: `Falha ao preparar a credencial: ${writeKey.stderr}` };
  }

  const args = ["push", remote, branch];
  if (force) args.push("--force");
  const sshCommand = `ssh -i ${keyPath} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`;
  const result = await podman(["exec", "-e", `GIT_SSH_COMMAND=${sshCommand}`, runtime.containerName, "git", ...args], {
    timeoutMs: 60000,
  });

  // limpeza best-effort — mesmo se falhar, a chave só existe na área
  // efêmera do container (nunca na pasta do projeto persistida no
  // Mac), então some de qualquer jeito quando o container for embora.
  await podman(["exec", runtime.containerName, "rm", "-f", keyPath]);

  return result;
}

export async function startPreview(projectSlug: string, command: string): Promise<{ url: string; started: boolean; detail: string }> {
  const runtime = requireProject(projectSlug);
  const result = await podman([
    "exec",
    "-d",
    "-e",
    `PORT=${PREVIEW_CONTAINER_PORT}`,
    runtime.containerName,
    "sh",
    "-c",
    command,
  ]);
  if (result.code !== 0) {
    throw new Error(`Falha ao iniciar o preview: ${result.stderr.trim()}`);
  }
  if (!runtime.previewHostPort) {
    return {
      url: "",
      started: true,
      detail: "Comando iniciado, mas não consegui descobrir a porta publicada no Mac — confira com `podman port`.",
    };
  }

  const url = `http://127.0.0.1:${runtime.previewHostPort}`;

  // espera um pouco e confere se o servidor já responde, em vez de só
  // "confiar" que o comando funcionou — instalação de dependências
  // (npm install) pode levar alguns segundos antes do servidor subir.
  for (let attempt = 0; attempt < 8; attempt++) {
    await new Promise((r) => setTimeout(r, 1500));
    const check = await podman(["exec", runtime.containerName, "sh", "-c", `wget -T 2 -q -O- http://127.0.0.1:${PREVIEW_CONTAINER_PORT} >/dev/null`]);
    if (check.code === 0) {
      return { url, started: true, detail: "Servidor respondendo." };
    }
  }
  return {
    url,
    started: true,
    detail: "Comando iniciado, mas o servidor ainda não respondeu depois de ~12s — pode estar instalando dependências ainda; tente abrir a URL em alguns segundos.",
  };
}

export async function stopAllProjects(): Promise<void> {
  const all = Array.from(projects.values());
  projects.clear();
  await Promise.allSettled(all.map((p) => stopProjectContainer(p.containerName)));
}

// --- sweep de inatividade -------------------------------------------
const sweepTimer = setInterval(() => {
  const now = Date.now();
  for (const [slug, runtime] of projects) {
    if (now - runtime.lastUsedAt > IDLE_TIMEOUT_MS) {
      projects.delete(slug);
      void stopProjectContainer(runtime.containerName);
    }
  }
}, SWEEP_INTERVAL_MS);
// `unref()`: esse timer não deve, sozinho, impedir o processo de
// encerrar (mesmo princípio de não segurar o event loop por engano).
sweepTimer.unref();
