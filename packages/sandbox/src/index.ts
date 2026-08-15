import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { okResult, errorResult } from "@sarah/tool-result";
import {
  createProject,
  writeProjectFile,
  runProjectCommand,
  gitCommit,
  gitPush,
  gitCreateBranch,
  currentBranch,
  getProjectGithubRepo,
  startPreview,
} from "./projects.js";
import { getGithubToken, createPullRequest, getDefaultBranch } from "./github.js";

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
 * são caminhos válidos.
 *
 * Fase 5, parte 3: REVOGA a regra da parte 2 de sempre perguntar
 * "Base44 ou local" antes de agir. Regra nova: `create_project` É O
 * PADRÃO — cria a pasta local E (se `pnpm github:auth` já foi rodado)
 * um repositório novo no GitHub pra esse projeto, sem perguntar nada.
 * Base44 só entra se o usuário pedir por nome explicitamente (ver
 * `BASE44_POLICY_TEXT` em `packages/core/src/index.ts` — reescrita
 * pra essa regra nova). O risco continua igual: pasta local +
 * repositório VAZIO no GitHub são baixo risco (reversíveis, nada
 * enviado ainda); `git_push` de conteúdo de verdade continua exigindo
 * confirmação de alto risco, sem exceção.
 *
 * Fase 6: GitHub completo (Pull Requests) — `create_project` continua
 * indo direto pra main/master, sem branch, pra projeto NOVO (isso não
 * muda). Pra uma MUDANÇA num projeto JÁ EXISTENTE, o fluxo vira: cria
 * uma branch nova (`git_create_branch`, baixo risco — local, aditiva,
 * reversível), escreve/commita nela, e só então `create_pull_request`
 * — que envia essa branch (nunca a main/master) e abre o PR de
 * verdade, tudo isso ALTO risco, mesmo nível de `git_push` (é
 * literalmente um `git_push` de uma branch, por dentro). Merge do PR
 * fica de fora DE PROPÓSITO — nunca automático, o usuário revisa e
 * mescla ele mesmo pelo GitHub; não existe (nem vai existir sem pedido
 * explícito) uma tool de merge aqui.
 */

const createProjectTool = tool(
  "create_project",
  "Cria um projeto de código novo (ou reabre um já existente nesta sessão) — uma pasta dedicada FORA " +
    "do repositório da própria SARAH (`~/SarahProjects/<slug>/`, com seu próprio git), rodando dentro " +
    "de um container isolado (sem acesso ao resto do Mac, sem acesso à rede local, só internet). " +
    "TAMBÉM cria automaticamente um repositório PRIVADO vazio no GitHub pra esse projeto (se " +
    "`pnpm github:auth` já foi configurado nesta máquina) e já deixa `origin` e a credencial de push " +
    "prontas — sem precisar de nenhum passo manual depois. Chame esta tool ANTES de qualquer outra " +
    "`code.*` pra esse projeto — as outras tools recebem o mesmo `project` (nome ou slug) que essa " +
    "retorna. Baixo risco: cria uma pasta + um repositório VAZIO, nada destrutivo, nenhum código é " +
    "enviado (isso é `git_push`, sempre alto risco, à parte).\n\n" +
    "ESTE É O CAMINHO PADRÃO pra criar um site/projeto/app — use direto, SEM perguntar nada, sempre " +
    "que o usuário não mencionar o Base44 pelo nome. Só use as tools `mcp__claude_ai_Base44__*` (app " +
    'builder externo, requer conta premium) se o usuário pedir explicitamente por nome (ex.: "faz pelo ' +
    'Base44", "cria no Base44").',
  {
    name: z.string().describe("nome do projeto (vira um slug: minúsculo, só letras/números/hífen)"),
  },
  async (args) => {
    try {
      const result = await createProject(args.name);
      return okResult({
        project: result.slug,
        hostPath: result.hostDir,
        note: result.alreadyExisted
          ? "Projeto já estava aberto nesta sessão — reaproveitado, nada recriado."
          : "Projeto novo criado (pasta + git init + container isolado).",
        github: result.github,
      });
    } catch (err) {
      return errorResult(err);
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
      return okResult({ written: target });
    } catch (err) {
      return errorResult(err);
    }
  }
);

const runCommandTool = tool(
  "run_command",
  "Roda um comando de shell dentro do container isolado do projeto (working dir = raiz do projeto). " +
    "Use pra instalar dependências (ex.: 'npm install'), rodar build/testes, ou qualquer outro " +
    "comando de desenvolvimento. O comando tem acesso à internet (necessário pra instalar pacotes) " +
    "mas NÃO tem acesso à rede local do Mac nem a nenhum arquivo fora da pasta do projeto. RISCO " +
    "MÉDIO (Fase 7 parte 3): o isolamento do container garante que nada FORA do projeto é afetado, " +
    "mas DENTRO do projeto um comando ainda pode apagar trabalho do usuário (ex.: 'rm -rf .'), então " +
    "confirma por padrão. Comandos simples de leitura/build/teste (ex.: 'ls', 'pwd', 'cat arquivo', " +
    "'npm test', 'npm run build', 'npm run dev', 'git status', 'git log', 'git diff') rodam direto, " +
    "sem confirmação — prefira UM desses sozinhos, sem encadear com ';'/'&&'/'|' (encadear tira o " +
    "comando da lista de auto-aprovação mesmo que cada parte pareça inofensiva sozinha, e passa a " +
    "confirmar). Qualquer coisa fora dessa lista (rm, mv, redirecionamento de escrita como '>', " +
    "instalar pacote não testado antes, mexer em .git/config, etc.) confirma antes de rodar.",
  {
    project: z.string().describe("slug/nome do projeto"),
    command: z.string().describe("comando de shell a rodar dentro do container — prefira um comando simples da allowlist (ver descrição da tool) quando possível, pra rodar sem pedir confirmação"),
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
      return errorResult(err);
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
      return errorResult(err);
    }
  }
);

const gitCreateBranchTool = tool(
  "git_create_branch",
  "Cria uma branch local nova (a partir do estado atual) e já muda pra ela — SÓ local, não envia nada " +
    "pra lugar nenhum (isso é create_pull_request ou git_push). Baixo risco: uma branch nova não afeta " +
    "a main/master nem o remoto, é aditiva e reversível. USE ISTO antes de escrever/commitar qualquer " +
    "MUDANÇA num projeto JÁ EXISTENTE que vá virar um Pull Request — nunca commite direto na main/master " +
    "de um projeto existente pra depois abrir PR. Não use ao CRIAR um projeto novo (create_project já " +
    "deixa o projeto na branch padrão, direto — isso não muda).",
  {
    project: z.string().describe("slug/nome do projeto"),
    branch: z.string().describe("nome da branch nova, ex.: 'feature/novo-botao' ou 'fix/typo-hero'"),
  },
  async (args) => {
    try {
      const result = await gitCreateBranch(args.project, args.branch);
      return { content: [{ type: "text", text: JSON.stringify({ exitCode: result.code, stdout: result.stdout, stderr: result.stderr }, null, 2) }] };
    } catch (err) {
      return errorResult(err);
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
        return errorResult(result.skipped);
      }
      return { content: [{ type: "text", text: JSON.stringify({ exitCode: result.code, stdout: result.stdout, stderr: result.stderr }, null, 2) }] };
    } catch (err) {
      return errorResult(err);
    }
  }
);

const createPullRequestTool = tool(
  "create_pull_request",
  "Abre um Pull Request DE VERDADE no GitHub a partir da branch atual do projeto (a que estiver com " +
    "checkout feito no container — normalmente criada antes com git_create_branch) contra `base_branch`. " +
    "ENVIA (`git push`) essa branch pro GitHub como parte da mesma chamada — ALTO RISCO SEMPRE, mesmo " +
    "nível de git_push, sem exceção (pede confirmação antes de rodar). Recusa com erro claro se a " +
    "branch atual for igual à `base_branch` (sinal de que git_create_branch não foi chamado antes) ou " +
    "se o projeto não tiver repositório no GitHub associado. SÓ ABRE o PR — nunca faz merge, isso é " +
    "sempre manual, decisão do usuário revisando pelo GitHub; não existe (e não deve existir sem pedido " +
    "explícito) uma tool de merge neste projeto.",
  {
    project: z.string().describe("slug/nome do projeto"),
    title: z.string().describe("título do Pull Request"),
    description: z.string().describe("descrição/corpo do Pull Request (Markdown), explicando a mudança"),
    base_branch: z
      .string()
      .optional()
      .describe(
        "branch base contra a qual o PR é aberto — se omitido, usa a branch padrão REAL do repositório " +
          "(consultada na hora no GitHub, nunca assumida 'main'/'master' — os dois nomes aparecem neste " +
          "projeto dependendo do repositório)"
      ),
  },
  async (args) => {
    try {
      const token = await getGithubToken();
      if (!token) {
        return errorResult("GitHub não configurado nesta máquina ainda — rode `pnpm github:auth` uma vez.");
      }

      const repoInfo = getProjectGithubRepo(args.project);
      if (!repoInfo) {
        return errorResult(
          `Projeto "${args.project}" não tem repositório no GitHub associado — sem isso não dá pra abrir um Pull Request.`
        );
      }

      const baseBranch = args.base_branch ?? (await getDefaultBranch(token, repoInfo.owner, repoInfo.repo));
      const head = await currentBranch(args.project);
      if (head === baseBranch) {
        return errorResult(
          `A branch atual do projeto ("${head}") já é a branch base ("${baseBranch}") — crie uma ` +
            "branch nova com git_create_branch e commite a mudança nela antes de abrir um Pull Request."
        );
      }

      const pushResult = await gitPush(args.project, "origin", head, false);
      if (pushResult.skipped) {
        return errorResult(pushResult.skipped);
      }
      if (pushResult.code !== 0) {
        return errorResult(`Falha ao enviar a branch "${head}" pro GitHub: ${pushResult.stderr.trim() || pushResult.stdout.trim()}`);
      }

      const pr = await createPullRequest(token, repoInfo.owner, repoInfo.repo, {
        title: args.title,
        body: args.description,
        head,
        base: baseBranch,
      });

      return okResult({ number: pr.number, url: pr.htmlUrl, headBranch: head, baseBranch });
    } catch (err) {
      return errorResult(err);
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
      return errorResult(err);
    }
  }
);

export const codeServer = createSdkMcpServer({
  name: "sarah-code",
  tools: [createProjectTool, writeFileTool, runCommandTool, gitCommitTool, gitCreateBranchTool, gitPushTool, createPullRequestTool, previewTool],
});

export { stopAllProjects } from "./projects.js";
export { saveProjectDeployKey } from "./git-credential.js";
export { saveGithubToken } from "./github.js";
export { graphicsServer } from "./graphics.js";
export { slidesServer } from "./slides.js";
export { figmaServer, saveFigmaToken } from "./figma.js";
