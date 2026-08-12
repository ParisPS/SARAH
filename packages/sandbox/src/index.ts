import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { createProject, writeProjectFile, runProjectCommand, gitCommit, gitPush, startPreview } from "./projects.js";

/**
 * Agente de código (Fase 5 parte 1) — primeira vez que a SARAH ganha
 * capacidade de executar comandos e escrever arquivos livremente.
 * Toda a garantia de segurança vem do ISOLAMENTO DO CONTAINER em si
 * (ver `packages/sandbox/src/podman.ts` e docs/architecture.md, seção
 * "Fase 5, parte 1"), validado de verdade antes de qualquer tool
 * existir: sem acesso ao filesystem real do Mac fora da pasta do
 * projeto montada, sem acesso à rede LOCAL (LAN) — só internet —, e
 * limites reais de CPU/memória aplicados pelo kernel.
 *
 * Por isso `create_project`/`write_file`/`run_command`/`git_commit`/
 * `preview` são BAIXO risco (ver LOW_RISK_TOOLS em
 * @sarah/permissions): a confirmação por linha de código escrita não
 * acrescentaria segurança nenhuma — o container já impede qualquer
 * dano ao Mac real, com ou sem confirmação. `git_push` é a ÚNICA
 * exceção, e fica de fora de propósito, SEMPRE alto risco, sem
 * exceção — regra definida desde a primeira mensagem deste projeto,
 * não muda por estar "dentro" do sandbox.
 *
 * Fase 5, parte 2: este sandbox local passou a dividir espaço com o
 * conector nativo do Base44 (`mcp__claude_ai_Base44__*`, outro jeito
 * de criar/hospedar um site, externo, requer conta premium) — os dois
 * são caminhos válidos, a escolha é sempre do usuário, nunca decidida
 * sozinha pelo agente (ver a description de `create_project` abaixo e
 * `BASE44_POLICY_TEXT` em `packages/core/src/index.ts`).
 */

const createProjectTool = tool(
  "create_project",
  "Cria um projeto de código novo (ou reabre um já existente nesta sessão) — uma pasta dedicada FORA " +
    "do repositório da própria SARAH (`~/SarahProjects/<slug>/`, com seu próprio git), rodando dentro " +
    "de um container isolado (sem acesso ao resto do Mac, sem acesso à rede local, só internet). " +
    "Chame esta tool ANTES de qualquer outra `code.*` pra esse projeto — as outras tools recebem o " +
    "mesmo `project` (nome ou slug) que essa retorna. Baixo risco: cria só uma pasta vazia + " +
    "container, nada destrutivo.\n\n" +
    "IMPORTANTE — desambiguação com Base44: esta NÃO é a única forma de criar um site/app disponível. " +
    "O conector `mcp__claude_ai_Base44__*` (app builder externo, requer conta premium) também cria e " +
    "hospeda projetos. Se o usuário pedir pra criar um site/projeto/app SEM já ter dito qual caminho " +
    "quer, NÃO chame esta tool (nem uma tool do Base44) direto — pergunte antes, explicitamente, com " +
    'as opções "Base44" e "Local (Claude Code)". Só chame create_project depois que o usuário escolher ' +
    '"Local", ou se o pedido original já deixou isso claro (ex.: "cria localmente", "usa o Claude Code").',
  {
    name: z.string().describe("nome do projeto (vira um slug: minúsculo, só letras/números/hífen)"),
  },
  async (args) => {
    try {
      const result = await createProject(args.name);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                ok: true,
                project: result.slug,
                hostPath: result.hostDir,
                note: result.alreadyExisted
                  ? "Projeto já estava aberto nesta sessão — reaproveitado, nada recriado."
                  : "Projeto novo criado (pasta + git init + container isolado).",
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (err) {
      return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }) }] };
    }
  }
);

const writeFileTool = tool(
  "write_file",
  "Escreve (cria ou sobrescreve) um arquivo dentro do projeto — caminho SEMPRE relativo à raiz do " +
    "projeto (nunca absoluto, nunca com '..'; tentativas de sair da pasta do projeto são bloqueadas). " +
    "Cria diretórios intermediários automaticamente se precisar. Baixo risco: só afeta a pasta " +
    "isolada deste projeto, nunca o resto do Mac.",
  {
    project: z.string().describe("slug/nome do projeto, retornado por create_project"),
    path: z.string().describe("caminho relativo do arquivo dentro do projeto, ex.: 'index.html' ou 'src/App.tsx'"),
    content: z.string().describe("conteúdo completo do arquivo (substitui o conteúdo atual, se existir)"),
  },
  async (args) => {
    try {
      const target = await writeProjectFile(args.project, args.path, args.content);
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, written: target }) }] };
    } catch (err) {
      return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }) }] };
    }
  }
);

const runCommandTool = tool(
  "run_command",
  "Roda um comando de shell dentro do container isolado do projeto (working dir = raiz do projeto). " +
    "Use pra instalar dependências (ex.: 'npm install'), rodar build/testes, ou qualquer outro " +
    "comando de desenvolvimento. O comando tem acesso à internet (necessário pra instalar pacotes) " +
    "mas NÃO tem acesso à rede local do Mac nem a nenhum arquivo fora da pasta do projeto. Baixo " +
    "risco: a garantia de segurança é o isolamento do container, não o conteúdo do comando em si.",
  {
    project: z.string().describe("slug/nome do projeto"),
    command: z.string().describe("comando de shell a rodar dentro do container, ex.: 'npm install && npm run build'"),
    timeoutSeconds: z.number().min(1).max(600).optional().describe("timeout em segundos (padrão 120, máximo 600)"),
  },
  async (args) => {
    try {
      const result = await runProjectCommand(args.project, args.command, args.timeoutSeconds);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ exitCode: result.code, stdout: result.stdout, stderr: result.stderr }, null, 2),
          },
        ],
      };
    } catch (err) {
      return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }) }] };
    }
  }
);

const gitCommitTool = tool(
  "git_commit",
  "Cria um commit local (git add -A + git commit) dentro do repositório do projeto — fica só no " +
    "container/pasta local, NÃO envia pra lugar nenhum (isso é git_push, outra tool). Baixo risco: " +
    "commit local é aditivo e reversível.",
  {
    project: z.string().describe("slug/nome do projeto"),
    message: z.string().describe("mensagem do commit"),
  },
  async (args) => {
    try {
      const result = await gitCommit(args.project, args.message);
      return { content: [{ type: "text", text: JSON.stringify({ exitCode: result.code, stdout: result.stdout, stderr: result.stderr }, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }) }] };
    }
  }
);

const gitPushTool = tool(
  "git_push",
  "ENVIA commits locais pra um repositório remoto (`git push`) — ação IRREVERSÍVEL, ALTO RISCO SEMPRE, " +
    "sem exceção, mesmo rodando dentro do sandbox isolado. Pede confirmação antes de rodar. Use " +
    "`force: true` SOMENTE se o usuário pedir um push forçado explicitamente — sobrescreve histórico " +
    "remoto, ainda mais perigoso. Precisa de uma credencial de deploy configurada pro projeto " +
    "(Keychain do macOS) — se não houver nenhuma, a tool recusa com uma mensagem clara em vez de " +
    "tentar algo inseguro.",
  {
    project: z.string().describe("slug/nome do projeto"),
    remote: z.string().default("origin").describe("nome do remote git (padrão: 'origin')"),
    branch: z.string().describe("branch a enviar"),
    force: z.boolean().optional().describe("push forçado (--force) — só se o usuário pedir explicitamente"),
  },
  async (args) => {
    try {
      const result = await gitPush(args.project, args.remote, args.branch, Boolean(args.force));
      if (result.skipped) {
        return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: result.skipped }) }] };
      }
      return { content: [{ type: "text", text: JSON.stringify({ exitCode: result.code, stdout: result.stdout, stderr: result.stderr }, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }) }] };
    }
  }
);

const previewTool = tool(
  "preview",
  "Sobe um servidor de desenvolvimento/preview dentro do container do projeto (ex.: 'npm run dev', " +
    "ou um servidor estático simples) e devolve uma URL em 127.0.0.1 que o USUÁRIO pode abrir no " +
    "navegador do Mac pra ver rodando de verdade. O comando deve deixar o servidor escutando na " +
    "porta indicada pela variável de ambiente PORT (já configurada como 3000 dentro do container). " +
    "A porta só é exposta em 127.0.0.1 do Mac (nunca na rede local). Baixo risco.",
  {
    project: z.string().describe("slug/nome do projeto"),
    command: z.string().describe("comando que inicia o servidor, escutando em $PORT, ex.: 'npx --yes serve -l $PORT .'"),
  },
  async (args) => {
    try {
      const result = await startPreview(args.project, args.command);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }) }] };
    }
  }
);

export const codeServer = createSdkMcpServer({
  name: "sarah-code",
  tools: [createProjectTool, writeFileTool, runCommandTool, gitCommitTool, gitPushTool, previewTool],
});

export { stopAllProjects } from "./projects.js";
export { saveProjectDeployKey } from "./git-credential.js";
