import { query } from "@anthropic-ai/claude-agent-sdk";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createGateway, classifyRisk, type ConfirmFn, type RiskLevel } from "@sarah/permissions";
import { AuditLog, type AuditRow } from "@sarah/audit";
import { fixturesServer } from "@sarah/fixtures";
import { appleCalendarServer, checkCalendarStatus } from "@sarah/apple-calendar";
import { notionServer, checkNotionStatus } from "@sarah/notion";
import { appleRemindersServer, checkRemindersStatus } from "@sarah/apple-reminders";
import { gmailServer, getDraftPreview, checkGmailStatus } from "@sarah/gmail";
import { createMemoryServer } from "@sarah/memory";
import { appleNotesServer, checkNotesStatus } from "@sarah/apple-notes";
import { codeServer, graphicsServer, slidesServer, figmaServer, stopAllProjects } from "@sarah/sandbox";

/**
 * Núcleo do agente: monta o Gateway de permissões, o audit log, a
 * memória persistente e o registro de tools MCP, e expõe UM prompt de
 * cada vez via `SarahSession.ask()`. Estrutura criada na Fase 0; a
 * partir da Fase 1 as tools de fixtures continuam registradas (servem
 * de sanity check) e passam a dividir espaço com integrações reais:
 * @sarah/apple-calendar, @sarah/notion, @sarah/apple-reminders e
 * @sarah/gmail. As duas primeiras têm uma tool `create_event` — a
 * desambiguação entre elas (Notion é o calendário principal/padrão,
 * Apple só quando pedido explicitamente, nunca as duas juntas) vive
 * inteiramente nas `description` de cada tool, não aqui — é o único
 * sinal que o agente tem pra escolher entre tools do MCP. Reminders é
 * um app diferente (lembrete, não compromisso/evento), então não
 * compete com as duas — mas a distinção também é feita só via
 * description, mesmo mecanismo. Gmail (leitura) não compete com
 * nenhuma delas, mas tem seu próprio concorrente: o conector nativo
 * `claude_ai_Gmail` do ambiente, que é bloqueado abaixo via
 * `disallowedTools` — a SARAH usa exclusivamente sua própria tool, que
 * passa pelo Gateway e pelo audit log.
 *
 * `send_draft` (Gmail): única tool de ALTO risco deste projeto que
 * ganhou uma confirmação melhorada — ver `formatConfirmationInput`
 * abaixo, injetado no Gateway pra buscar e mostrar o conteúdo do
 * rascunho (Para/Assunto/corpo) antes de perguntar "(s/n)"/mostrar um
 * dialog, em vez do `draftId` cru. Só o core conhece @sarah/gmail o
 * suficiente pra fazer isso — @sarah/permissions continua sem
 * depender de nenhum pacote de tool específico, só recebe a função
 * pronta.
 *
 * FASE 5, PARTE 2: mesmo tratamento pro conector nativo do Base44
 * (`mcp__claude_ai_Base44__*`) — DIFERENTE do Gmail nativo, este NÃO é
 * bloqueado (fica disponível de propósito, pra quem tem conta
 * premium), mas nunca é escolhido sozinho pelo agente. Como cinto de
 * segurança redundante, TODA tool do Base44 é classificada alto risco
 * (`FORCE_HIGH_RISK` em @sarah/permissions, fora de `LOW_RISK_TOOLS`)
 * e ganha um preview de confirmação que deixa explícito que é um
 * serviço pago — mesmo se o agente usar o Base44 sem o usuário ter
 * pedido, o Gateway força a parada. Essa parte NÃO mudou na parte 3
 * abaixo.
 *
 * FASE 5, PARTE 3: revoga a regra da parte 2 de sempre PERGUNTAR
 * "Base44 ou local" antes de agir. `code.create_project` virou o
 * caminho PADRÃO (cria pasta local + repositório no GitHub sozinho,
 * sem fricção — ver `packages/sandbox/src/projects.ts`), usado direto
 * sem perguntar nada; Base44 só entra se o usuário pedir por nome (ver
 * `BASE44_POLICY_TEXT`, reescrita pra essa regra nova).
 *
 * FASE 4, PARTE 1: `confirm` (o "faz a pergunta e espera resposta" de
 * verdade — `readline.question("... (s/n) ")` no terminal, um dialog
 * nativo no Electron) SAIU de dentro de @sarah/permissions e passou a
 * ser um parâmetro obrigatório de `createSarahSession()`, repassado
 * direto pro Gateway (ver `ConfirmFn` em @sarah/permissions).
 *
 * FASE 4, PARTE 2: este arquivo deixou de ser um loop de REPL de
 * terminal (`while(true) { rl.question(...) }`) — essa era a única
 * parte daqui que assumia "existe stdin/stdout do outro lado", o que
 * não faz sentido pra uma janela Electron esperando eventos de IPC.
 * A lógica de "como recebo o próximo pedido do usuário e como mostro
 * a resposta" agora pertence inteiramente a cada app (`apps/cli`
 * continua com seu loop `readline`; `apps/menubar` usa um handler de
 * IPC por mensagem). O que sobra aqui — Gateway, audit log, memória,
 * registro das tools MCP, `resume` de sessão — é usado IDENTICAMENTE
 * pelos dois, através de `createSarahSession()`: uma função que monta
 * tudo isso uma vez e devolve um objeto com `ask(prompt)` (chamável
 * quantas vezes forem necessárias, uma por turno) e `close()`.
 *
 * Memória de SESSÃO (`resume` do Agent SDK): o histórico da conversa
 * continua entre chamadas de `ask()` na MESMA `SarahSession` (mesmo
 * processo, mesma janela/execução aberta) — `sessionId` é capturado
 * da mensagem `system`/`init` da primeira chamada e reusado via
 * `options.resume` nas seguintes. Reseta ao encerrar a sessão (nova
 * `createSarahSession()` = conversa nova) — isso é o esperado, não é
 * memória persistente (essa é @sarah/memory, ver abaixo).
 *
 * Memória PERSISTENTE (sobrevive a reiniciar o processo, diferente do
 * `resume` acima): @sarah/memory guarda fatos/preferências em SQLite
 * próprio. Preferências (`category === "preferencia"`) precisam
 * influenciar o comportamento de OUTRAS tools automaticamente (ex.:
 * lista padrão de lembretes) — depender do agente decidir chamar
 * `memory.recall` antes de cada ação não é confiável (é uma decisão
 * que ele teria que acertar de novo em toda conversa nova). Por isso
 * `memoryStore.listByCategory("preferencia")` é lido aqui, SEM CACHE,
 * antes de cada `ask()`, e injetado via `systemPrompt` — chega pro
 * modelo garantido, não como uma tool que ele pode esquecer de
 * chamar. `memory.recall` continua existindo como tool, pra buscas
 * sob demanda (ex.: "o que você sabe sobre mim?").
 *
 * FASE 4, PARTE 2 — bug real corrigido: até aqui, o audit log e a
 * memória usavam caminho RELATIVO (`./data/sarah.db`), resolvido a
 * partir do `cwd` do processo em execução. Isso "funcionava" enquanto
 * só existia `apps/cli` (sempre rodado a partir da raiz do monorepo,
 * então o `cwd` batia com o esperado) — mas descoberto rodando de
 * verdade que `pnpm --filter cli dev` na prática executa com `cwd` em
 * `apps/cli/`, não na raiz (`data/` acabou sendo criado ali, não em
 * `./data` da raiz). Com uma SEGUNDA interface (`apps/menubar`, com
 * seu próprio `cwd`), esse acoplamento ao `cwd` quebraria a premissa
 * de "audit log e memória são compartilhados entre todas as
 * interfaces" — cada app veria um histórico/memória diferente.
 * Corrigido resolvendo os dois caminhos de forma ABSOLUTA, a partir
 * da localização deste próprio arquivo-fonte (mesmo padrão já usado
 * em `apps/cli/src/main.ts` pra achar o `.env`), sempre apontando pra
 * `<raiz do repo>/data/`, não importa de onde o processo foi lançado.
 *
 * IMPORTANTE: as tools de teste NÃO entram em `allowedTools`. Nesse
 * SDK, um nome "solto" em `allowedTools` pré-aprova a tool inteira —
 * o `canUseTool` (nosso Gateway) nem chega a ser chamado pra ela. A
 * gente descobriu isso na prática: o SDK emite um warning
 * (CLAUDE_SDK_CAN_USE_TOOL_SHADOWED) avisando exatamente isso.
 * Deixando as tools de fora de `allowedTools`, toda chamada "cai" no
 * `canUseTool` normalmente — que é o comportamento que a gente quer.
 *
 * `disallowedTools` bloqueia de vez as tools nativas do agente
 * (Bash, Write, Edit etc.) — nada disso deve existir antes do sandbox
 * da Fase 5. Mesmo que algum nome aqui não bata 100% com a versão do
 * SDK instalada, qualquer tool não reconhecida cai no Gateway e é
 * classificada como alto risco por padrão (ver `classifyRisk` em
 * @sarah/permissions) — ou seja, o pior caso é pedir confirmação a
 * mais, nunca executar em silêncio.
 */
const BUILTIN_TOOLS_TO_BLOCK = [
  "Bash",
  "Read",
  "Write",
  "Edit",
  "NotebookEdit",
  "Glob",
  "Grep",
  "WebSearch",
  "WebFetch",
  "Task",
  // Conector nativo do Gmail do claude.ai — decisão explícita: a SARAH
  // usa exclusivamente sua própria tool `gmail.list_recent_emails`
  // (OAuth próprio via GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET, ver
  // packages/gmail), nunca esse conector, mesmo que ele apareça
  // disponível no ambiente. O glob bloqueia toda a namespace, não só
  // a tool específica que já apareceu (search_threads) — qualquer
  // outra tool que esse conector exponha (get_message, list_labels
  // etc.) cai no mesmo bloqueio.
  "mcp__claude_ai_Gmail__*",
];

/**
 * Rótulos legíveis (pt-BR) por ação do conector nativo do Base44
 * (Fase 5, parte 2) — usados só no preview de confirmação, pra não
 * mostrar o nome cru da tool (`create_base44_app` etc.) sem contexto.
 * Lista best-effort: uma tool nova do conector que não esteja aqui
 * ainda funciona (cai no fallback `action` cru dentro de
 * `formatConfirmationInput`), só perde o texto bonito.
 */
const BASE44_ACTION_LABELS: Record<string, string> = {
  create_base44_app: "criar um app novo no Base44 (a partir de uma descrição)",
  edit_base44_app: "pedir uma mudança num app existente no Base44",
  create_checkpoint: "criar um checkpoint (snapshot) do app no Base44",
  edit_file: "editar um arquivo dentro do app no Base44",
  write_file: "escrever um arquivo dentro do app no Base44",
  read_file: "ler um arquivo do app no Base44",
  list_directory: "listar arquivos do app no Base44",
  grep: "buscar texto nos arquivos do app no Base44",
  run_command: "rodar um comando dentro do ambiente do Base44",
  get_app_status: "consultar o status de build do app no Base44",
  get_app_preview_url: "pegar a URL de preview do app no Base44",
  list_user_apps: "listar os apps do usuário no Base44",
  create_entities: "criar registros de dados no Base44",
  update_entities: "atualizar registros de dados no Base44",
  query_entities: "consultar registros de dados no Base44",
  create_entity_schema: "criar um modelo de dados novo no Base44",
  update_entity_schema: "alterar um modelo de dados existente no Base44",
  list_entity_schemas: "listar os modelos de dados do app no Base44",
  list_connectors: "listar integrações conectadas no Base44",
  initiate_connector_connection: "conectar uma integração externa ao app no Base44",
  "import-claude-design-from-url": "importar um design pro app no Base44",
};

/**
 * Formatador de confirmação pro Gateway (ver `FormatConfirmationInput`
 * em @sarah/permissions) — `send_draft` (Gmail), `git_push` (Fase 5
 * parte 1) e qualquer tool do Base44 (Fase 5 parte 2) têm tratamento
 * especial: mostram o que vai acontecer de forma legível ANTES de
 * pedir confirmação, em vez do input cru em JSON. Base44 entra aqui
 * pelo mesmo motivo que as outras duas — não é sobre reversibilidade
 * (algumas ações do Base44 são só leitura), é sobre o usuário
 * enxergar CLARAMENTE que está prestes a acionar um serviço externo
 * pago (conta premium), não só um `mcp__claude_ai_Base44__xyz` cru.
 * Erro ao formatar (ex.: rascunho já apagado) cai pro fallback padrão
 * do Gateway — não bloqueia a confirmação em si, só perde o preview
 * bonito nesse caso raro.
 */
async function formatConfirmationInput(toolName: string, toolInput: unknown): Promise<string | null> {
  if (toolName.startsWith("mcp__claude_ai_Base44__")) {
    const action = toolName.replace("mcp__claude_ai_Base44__", "");
    const label = BASE44_ACTION_LABELS[action] ?? action;
    return (
      `   Base44 — app builder externo, REQUER CONTA PREMIUM\n` +
      `   Ação: ${label}\n` +
      `   Entrada: ${JSON.stringify(toolInput)}`
    );
  }

  if (toolName === "mcp__sarah-gmail__send_draft") {
    const { draftId } = toolInput as { draftId?: string };
    if (!draftId) return null;

    const draft = await getDraftPreview(draftId);
    return (
      `   Rascunho a enviar:\n` +
      `   Para: ${draft.to}\n` +
      `   Assunto: ${draft.subject}\n` +
      `   Corpo: ${draft.bodyPreview}`
    );
  }

  if (toolName === "mcp__sarah-code__git_push") {
    const { project, remote, branch, force } = toolInput as {
      project?: string;
      remote?: string;
      branch?: string;
      force?: boolean;
    };
    return (
      `   git push${force ? " --force" : ""}\n` +
      `   Projeto: ${project ?? "?"}\n` +
      `   Remote: ${remote ?? "origin"}\n` +
      `   Branch: ${branch ?? "?"}` +
      (force ? "\n   ATENÇÃO: --force pode sobrescrever histórico remoto." : "")
    );
  }

  if (toolName === "mcp__sarah-code__create_pull_request") {
    const { project, title, description, base_branch } = toolInput as {
      project?: string;
      title?: string;
      description?: string;
      base_branch?: string;
    };
    return (
      `   Abrir Pull Request no GitHub (envolve dar push da branch atual — mesma trava do git_push)\n` +
      `   Projeto: ${project ?? "?"}\n` +
      `   Título: ${title ?? "?"}\n` +
      `   Base: ${base_branch ?? "(branch padrão do repositório)"}\n` +
      `   Descrição: ${description ?? "(vazia)"}\n` +
      `   OBS: só abre o PR — merge continua manual, pelo GitHub.`
    );
  }

  return null;
}

/**
 * Regra de desambiguação Base44 vs sandbox local — Fase 5 parte 2
 * introduziu isso como "sempre pergunta antes" (via AskUserQuestion);
 * Fase 5 parte 3 REVOGOU essa regra por instrução explícita do
 * usuário. Regra atual: `code.create_project` é o caminho PADRÃO,
 * usado direto sem perguntar nada — desde a parte 3 ele também cria o
 * repositório no GitHub sozinho (ver `packages/sandbox/src/projects.ts`,
 * `setUpGithubRepo`), então não sobra motivo prático pra preferir
 * Base44 por padrão. Base44 só entra em jogo se o usuário pedir por
 * nome. Injetada SEMPRE no `systemPrompt` (não só na `description` de
 * `create_project`) pelo mesmo motivo de antes: a description
 * influencia mas não é garantida — o `systemPrompt` chega pro modelo
 * em toda chamada, sem depender de releitura atenta no meio de um
 * pedido mais longo. O Gateway (`FORCE_HIGH_RISK` em
 * @sarah/permissions, inalterado) continua sendo o cinto de segurança
 * pro caso do agente usar o Base44 sem o usuário ter pedido — mesmo
 * assim, sempre exige confirmação explícita mencionando a conta
 * premium.
 */
const BASE44_POLICY_TEXT =
  "Pra criar um site/projeto/app, o caminho PADRÃO é `code.create_project` — use direto, SEM perguntar " +
  '"Base44 ou local", mesmo que o usuário não tenha especificado nada. Desde a Fase 5 parte 3, ' +
  "`code.create_project` já cria a pasta local E um repositório novo no GitHub pra esse projeto " +
  "automaticamente (sem fricção, sem pedir confirmação — isso é baixo risco). Só use as tools " +
  "`mcp__claude_ai_Base44__*` (serviço externo, requer conta Base44 premium) se o usuário pedir POR " +
  'NOME, explicitamente (ex.: "faz pelo Base44", "cria no Base44", "usa o Base44") — nunca por conta ' +
  "própria, mesmo que pareça mais conveniente pra um pedido específico.";

/**
 * Regra de fluxo git — branch vs. commit direto (Fase 6, GitHub
 * completo: Pull Requests). Sem isso, nada no schema das tools por si
 * só impede o agente de commitar/pushar direto na main/master de um
 * projeto já existente com histórico real — só a INTENÇÃO (é projeto
 * novo ou mudança num que já existe?) distingue os dois casos, e isso
 * só o agente sabe a partir do pedido em si, não dá pra derivar da
 * assinatura de nenhuma tool. Mesmo mecanismo de injeção sempre-
 * presente já usado pra `BASE44_POLICY_TEXT`.
 */
const GIT_WORKFLOW_POLICY_TEXT =
  "Fluxo de git: criar um projeto NOVO (`code.create_project`) continua indo direto pra a branch " +
  "padrão (main/master), sem branch — isso não muda. Mas ao fazer uma MUDANÇA num projeto JÁ " +
  "EXISTENTE (o usuário pede pra alterar/adicionar algo num site/app que já foi criado antes), o " +
  "fluxo é: 1) `code.git_create_branch` com um nome descritivo da mudança (baixo risco, só local); " +
  "2) `code.write_file`/`code.run_command`/`code.git_commit` normalmente, já nessa branch; 3) " +
  "`code.create_pull_request` (ALTO risco — pede confirmação, envolve push de verdade) pra enviar " +
  "essa branch e abrir o Pull Request. NUNCA commite/pushe direto na main/master de um projeto já " +
  "existente pra depois abrir PR — a branch precisa existir ANTES do commit. NUNCA faça merge do PR " +
  "sozinho — não existe tool de merge aqui de propósito; depois de aberto, o PR fica esperando o " +
  "usuário revisar e mesclar pelo GitHub.";

// Ver "bug real corrigido" no comentário do topo — caminho absoluto a
// partir deste arquivo-fonte, não do `cwd` do processo que importou
// este pacote. `packages/core/src/index.ts` -> sobe 3 níveis -> raiz.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const AUDIT_DB_PATH = join(REPO_ROOT, "data", "sarah.db");
const MEMORY_DB_PATH = join(REPO_ROOT, "data", "sarah-memory.db");

export interface CreateSarahSessionOptions {
  /** Ver `ConfirmFn` em @sarah/permissions — quem chama decide a interface (terminal, dialog...). */
  confirm: ConfirmFn;
}

/**
 * Um pedaço do que `ask()` transmite: texto de resposta, ou o aviso
 * de que uma tool rodou (nome qualificado + risco, na ordem em que o
 * modelo chamou). Existe desde a Fase 4 parte 3 — antes, `ask()` só
 * devolvia texto; `apps/menubar` precisa saber QUAL tool rodou pra
 * mostrar o selo discreto embaixo da resposta ("🗓️ Notion · baixo
 * risco"), em vez de só o texto corrido. `apps/cli` recebe os mesmos
 * eventos e simplesmente ignora os do tipo `"tool"` — o terminal
 * continua mostrando só o texto, comportamento idêntico ao de antes.
 */
export type SarahEvent = { type: "text"; text: string } | { type: "tool"; toolName: string; risk: RiskLevel };

/**
 * Status REAL de uma integração, pro painel "status das integrações"
 * do dashboard (Fase 4 parte 3.5) — nunca um indicador decorativo.
 * `id` bate com o prefixo do server MCP (mesmo valor que aparece em
 * `countByServer()`/`tool_name`), pra o renderer conseguir cruzar as
 * duas fontes se quiser (ex.: destacar uma integração configurada mas
 * nunca usada).
 */
export interface IntegrationStatus {
  id: string;
  label: string;
  configured: boolean;
  detail: string;
}

export interface DashboardData {
  integrations: IntegrationStatus[];
  riskCounts: { low: number; high: number };
  categoryCounts: Array<{ server: string; count: number }>;
  hourlyActivity: Array<{ hourStart: string; count: number }>;
}

export interface SarahSession {
  /**
   * Envia um prompt e devolve os eventos da resposta conforme chegam
   * (um `AsyncGenerator` de `SarahEvent`) — texto (pra mostrar
   * incrementalmente) e avisos de tool usada (pra quem quiser
   * exibir). Mantém `resume` entre chamadas nesta mesma sessão
   * automaticamente.
   */
  ask(prompt: string): AsyncGenerator<SarahEvent, void, unknown>;
  /**
   * Últimas `limit` decisões do Gateway (mesma fonte que
   * `data/sarah.db`) — pro painel de histórico do `apps/menubar`, sem
   * precisar abrir um terminal/SQLite à parte. Reusa
   * `AuditLog.recent()`, já existente desde a Fase 0.
   */
  history(limit?: number): AuditRow[];
  /**
   * Dados REAIS pro dashboard de `apps/menubar` (Fase 4 parte 3.5):
   * status de cada integração (config presente ou não — nunca uma
   * chamada de API de verdade, ver cada `check*Status()` por
   * integração), e três agregações do audit log (`@sarah/audit`).
   * Nenhum indicador aqui é inventado/decorativo — painel sem dado
   * real disponível simplesmente não existe.
   */
  dashboard(): Promise<DashboardData>;
  /**
   * Fecha o audit log e a memória (SQLite), e derruba TODOS os
   * containers de projeto ainda abertos (Fase 5) — chamar ao encerrar
   * o app/janela. Virou `async` nesta fase porque parar containers
   * de verdade (`podman stop`) não é instantâneo; os callers (ver
   * `apps/cli`/`apps/menubar`) esperam essa Promise antes de encerrar
   * o próprio processo, pra não deixar container órfão pra trás.
   */
  close(): Promise<void>;
}

/**
 * Fábrica da sessão da SARAH: monta Gateway, audit log, memória
 * persistente e o registro de tools MCP UMA VEZ, e devolve um objeto
 * reutilizável pra fazer quantos pedidos forem necessários. Cada app
 * (`apps/cli`, `apps/menubar`) cria a sua própria `SarahSession` — o
 * `confirm` injetado é o que diferencia uma interface da outra.
 */
export function createSarahSession(options: CreateSarahSessionOptions): SarahSession {
  const audit = new AuditLog(AUDIT_DB_PATH);
  const canUseTool = createGateway({
    onDecision: (entry) => audit.record(entry),
    formatConfirmationInput,
    confirm: options.confirm,
  });
  const { server: memoryServer, store: memoryStore } = createMemoryServer(MEMORY_DB_PATH);

  // Session ID da conversa atual, capturado da mensagem system/init da
  // primeira chamada a query() — reusado via `resume` nas chamadas
  // seguintes DENTRO desta mesma `SarahSession`, pra manter contexto
  // entre prompts (ex.: "esse mesmo evento" numa mensagem separada).
  // Reseta ao criar uma sessão nova — isso é o esperado, não um bug:
  // memória de sessão não é memória persistente.
  let sessionId: string | undefined;

  async function* ask(prompt: string): AsyncGenerator<SarahEvent, void, unknown> {
    // Sem cache: busca fresca antes de cada pergunta, mesma lição já
    // registrada no docs/architecture.md sobre o bug de cache do
    // schema do Notion. Uma consulta SQLite local é desprezível.
    const preferences = memoryStore.listByCategory("preferencia");
    const preferencesText =
      preferences.length > 0
        ? "Preferências conhecidas do usuário — aplique automaticamente ao usar outras tools, " +
          "sem precisar perguntar de novo:\n" +
          preferences.map((p) => `- ${p.content}`).join("\n")
        : undefined;
    // BASE44_POLICY_TEXT e GIT_WORKFLOW_POLICY_TEXT entram SEMPRE (não
    // dependem de haver preferência guardada) — são regra de
    // comportamento do agente, não fato sobre o usuário.
    const systemPromptAppend = [BASE44_POLICY_TEXT, GIT_WORKFLOW_POLICY_TEXT, preferencesText].filter(Boolean).join("\n\n");

    const stream = query({
      prompt,
      options: {
        mcpServers: {
          "sarah-fixtures": fixturesServer,
          "sarah-apple-calendar": appleCalendarServer,
          "sarah-notion": notionServer,
          "sarah-apple-reminders": appleRemindersServer,
          "sarah-gmail": gmailServer,
          "sarah-memory": memoryServer,
          "sarah-apple-notes": appleNotesServer,
          "sarah-code": codeServer,
          "sarah-graphics": graphicsServer,
          "sarah-slides": slidesServer,
          "sarah-figma": figmaServer,
        },
        disallowedTools: BUILTIN_TOOLS_TO_BLOCK,
        canUseTool,
        ...(sessionId ? { resume: sessionId } : {}),
        systemPrompt: { type: "preset" as const, preset: "claude_code" as const, append: systemPromptAppend },
      },
    });

    for await (const message of stream) {
      if (message.type === "system" && message.subtype === "init") {
        sessionId = message.session_id;
      }
      if (message.type === "assistant") {
        for (const block of message.message.content) {
          if (block.type === "text") {
            yield { type: "text", text: block.text };
          } else if (block.type === "tool_use") {
            // Mesmo nome qualificado que `canUseTool`/o Gateway recebem
            // (confirmado no tipo `BetaToolUseBlock` do SDK da
            // Anthropic: `{ id, input, name, type: "tool_use" }`) — não
            // é preciso esperar o `onDecision` do Gateway pra saber
            // qual tool rodou, o mesmo stream de mensagens já diz.
            yield { type: "tool", toolName: block.name, risk: classifyRisk(block.name) };
          }
        }
      }
    }
  }

  function history(limit = 20): AuditRow[] {
    return audit.recent(limit);
  }

  /**
   * `Promise.allSettled`, não `Promise.all`: uma integração com
   * problema (ex.: bridge JXA travando por algum motivo novo) não
   * pode derrubar o dashboard inteiro — vira `configured: false` com
   * o erro como detalhe, as outras quatro continuam aparecendo.
   */
  async function dashboard(): Promise<DashboardData> {
    const checks: Array<{ id: string; label: string; run: () => Promise<{ configured: boolean; detail: string }> }> = [
      { id: "sarah-apple-calendar", label: "Apple Calendar", run: checkCalendarStatus },
      { id: "sarah-apple-reminders", label: "Apple Reminders", run: checkRemindersStatus },
      { id: "sarah-notion", label: "Notion Calendar", run: checkNotionStatus },
      { id: "sarah-gmail", label: "Gmail", run: checkGmailStatus },
      { id: "sarah-apple-notes", label: "Apple Notes", run: checkNotesStatus },
    ];
    const settled = await Promise.allSettled(checks.map((c) => c.run()));
    const integrations: IntegrationStatus[] = settled.map((result, i) => {
      const { id, label } = checks[i];
      if (result.status === "fulfilled") {
        return { id, label, ...result.value };
      }
      return { id, label, configured: false, detail: result.reason instanceof Error ? result.reason.message : String(result.reason) };
    });

    return {
      integrations,
      riskCounts: audit.riskCounts(),
      categoryCounts: audit.countByServer(),
      hourlyActivity: audit.hourlyBuckets(24),
    };
  }

  async function close(): Promise<void> {
    await stopAllProjects();
    audit.close();
    memoryStore.close();
  }

  return { ask, history, dashboard, close };
}
