import type { CanUseTool, PermissionResult } from "@anthropic-ai/claude-agent-sdk";

/**
 * Fase 7 parte 3: `"medium"` chegou pra cobrir o meio-termo entre
 * "roda sem perguntar" e "sempre pausa e pergunta" — ver
 * `MEDIUM_RISK_TOOLS`/`isAutoApprovedMediumRisk` abaixo pro
 * raciocínio completo (documentado também em
 * `docs/architecture.md`, seção da Fase 7 parte 3).
 */
export type RiskLevel = "low" | "medium" | "high";
export type Decision = "auto-allow" | "confirmed" | "denied";

/**
 * Política central de risco.
 *
 * De propósito, NENHUMA tool decide seu próprio risco — isso vive só
 * aqui, num único lugar auditável. Fase 0: lista estática por nome de
 * tool. A partir da Fase 2/3, isso vira uma função que também olha o
 * `input` da chamada (ex.: "apagar" vs "ler" na mesma tool não têm o
 * mesmo risco).
 *
 * Importante: o padrão é HIGH. Uma tool nova, desconhecida, entra como
 * alto risco até alguém explicitamente listá-la como baixo risco —
 * fail-safe, não fail-open.
 */
const LOW_RISK_TOOLS = new Set<string>([
  "mcp__sarah-fixtures__ping",
  // Apple Calendar (Fase 1): ler eventos é leitura pura. Criar evento
  // é aditivo e reversível — não apaga nem sobrescreve nada que já
  // existia, o pior caso é o usuário precisar apagar manualmente o
  // evento criado depois. Por isso as duas entram como baixo risco,
  // diferente de uma eventual `delete_event` no futuro (essa sim
  // destrutiva, ficaria de fora dessa lista).
  "mcp__sarah-apple-calendar__list_events",
  "mcp__sarah-apple-calendar__create_event",
  // Notion Calendar (calendário principal do usuário): mesma
  // justificativa de apple_calendar.create_event — criar página é
  // aditivo e reversível, não apaga nem sobrescreve nada existente.
  "mcp__sarah-notion__create_event",
  // Apple Reminders: mesma justificativa de apple_calendar — listar é
  // leitura pura, criar é aditivo e reversível (não apaga nem
  // sobrescreve nenhum lembrete existente).
  "mcp__sarah-apple-reminders__list_reminders",
  "mcp__sarah-apple-reminders__create_reminder",
  // Gmail (leitura): list_recent_emails/get_message usam só leitura —
  // sem nenhum efeito colateral possível (não envia, não apaga, não
  // marca como lido). Ainda mais claramente baixo risco que
  // list_events/list_reminders.
  "mcp__sarah-gmail__list_recent_emails",
  "mcp__sarah-gmail__get_message",
  // Gmail (rascunhos, Fase 3): create_draft/reply_draft são aditivos e
  // reversíveis — criar um rascunho não afeta ninguém, o e-mail nunca
  // sai da caixa de saída (o código nunca chama o endpoint de enviar,
  // ver packages/gmail/src/client.ts e docs/architecture.md). Uma
  // eventual tool de ENVIAR (nunca implementada, decisão de projeto)
  // ficaria de fora desta lista — essa sim de alto risco de verdade.
  "mcp__sarah-gmail__create_draft",
  "mcp__sarah-gmail__reply_draft",
  // `mcp__sarah-gmail__send_draft` fica DE FORA de propósito — cai no
  // fail-safe de alto risco. É a primeira ação verdadeiramente
  // irreversível de e-mail do projeto: diferente de criar rascunho, um
  // e-mail enviado não pode ser "desenviado". Ver
  // packages/core/src/index.ts pro formatConfirmationInput que busca
  // o conteúdo do rascunho antes de pedir confirmação, em vez de só
  // mostrar o draft_id cru.
  // Memória persistente: remember é aditivo (nunca sobrescreve/apaga),
  // recall é leitura pura — mesma justificativa de sempre. forget
  // (exclusão permanente) fica DE FORA de propósito: cai no fail-safe
  // de alto risco, exige confirmação, igual qualquer ação destrutiva
  // deste projeto.
  "mcp__sarah-memory__remember",
  "mcp__sarah-memory__recall",
  // Apple Notes: mesma justificativa de apple_calendar/apple_reminders
  // — listar é leitura pura, criar é aditivo e reversível (não apaga
  // nem sobrescreve nenhuma nota existente).
  "mcp__sarah-apple-notes__list_notes",
  "mcp__sarah-apple-notes__create_note",
  // Apple Contacts (Fase 8, FaceTime): só BUSCA (find) existe — leitura
  // pura, sem efeito colateral possível, mesma justificativa de
  // list_events/list_reminders/list_notes. Ligar de verdade é a tool
  // SEPARADA `facetime.call`, essa sim fora desta lista (ver
  // MEDIUM_RISK_TOOLS abaixo).
  "mcp__sarah-apple-contacts__find",
  // Sandbox de código (Fase 5, parte 1): a garantia de segurança destas
  // quatro tools vem do ISOLAMENTO DO CONTAINER em si — validado de
  // verdade (ver docs/architecture.md) que o container não enxerga o
  // filesystem real do Mac fora da pasta do projeto, não alcança a
  // rede local (só internet), e tem limites reais de CPU/memória.
  // Confirmar por linha de comando/arquivo escrito não acrescentaria
  // segurança nenhuma a isso — por isso todas entram como baixo risco,
  // igual às outras integrações aditivas/reversíveis. `run_command`
  // fica DE FORA desta lista — a partir da Fase 7 parte 3 ela é risco
  // MÉDIO (ver `MEDIUM_RISK_TOOLS` abaixo): o isolamento do container
  // continua sendo a garantia de que nada FORA do projeto é afetado,
  // mas DENTRO do projeto um comando arbitrário ainda pode apagar
  // trabalho do usuário (`rm -rf .`, por exemplo) sem que o container
  // em si tenha feito nada de errado — essa é uma classe de risco que
  // as outras quatro tools (caminho e efeito sempre fixos e aditivos)
  // não têm.
  "mcp__sarah-code__create_project",
  "mcp__sarah-code__write_file",
  "mcp__sarah-code__git_commit",
  "mcp__sarah-code__preview",
  // Fase 6 (Pull Requests): criar uma branch LOCAL nova é a mesma
  // garantia de `git_commit` — não sai do container, não toca a
  // main/master nem o remoto, é aditiva e reversível (`git branch -D`
  // desfaz sem rastro). `create_pull_request` fica DE FORA de
  // propósito, ver comentário de `git_push` logo abaixo — ela envia
  // essa branch pro GitHub como parte da mesma chamada, mesma trava.
  "mcp__sarah-code__git_create_branch",
  // Gráficos vetoriais (Fase 5 parte 4): mesma garantia de segurança
  // de `write_file`/`run_command` acima — o SVG é escrito e a
  // rasterização roda dentro do MESMO container isolado de `code.*`,
  // nada novo em termos de superfície de risco. Aditivo/reversível
  // (só escreve arquivos em assets/ do projeto).
  "mcp__sarah-graphics__create_svg",
  "mcp__sarah-graphics__export_raster",
  // Geração de slides (Fase 5 parte 5): mesma justificativa —
  // `pptxgenjs` escreve o .pptx direto na pasta do projeto (aditivo,
  // reversível), sem tocar nada fora dali. Não roda dentro do
  // container (é JS puro, sem binário de sistema envolvido), mas a
  // garantia é a mesma: só a pasta do projeto pode ser escrita
  // (`resolveProjectFilePath`, a mesma validação de path traversal de
  // `code.write_file`).
  "mcp__sarah-slides__create_presentation",
  // Extração de assets do Figma (Fase 5 parte 6): SÓ leitura do lado
  // do Figma (nada é escrito de volta lá) + escrita dentro da pasta
  // do projeto (mesma validação de path traversal de sempre). Editar
  // o Figma diretamente é uma decisão separada, de fora do escopo
  // desta tool — se um dia existir, essa sim entraria como candidata
  // a alto risco, por analogia com qualquer ação que modifica um
  // sistema externo do usuário.
  "mcp__sarah-figma__export_assets",
  // `mcp__sarah-code__git_push` fica DE FORA de propósito — SEMPRE
  // alto risco, sem exceção, mesmo dentro do sandbox. Regra definida
  // desde a primeira mensagem deste projeto: git push/--force nunca é
  // baixo risco, ponto final. Ver formatConfirmationInput em
  // packages/core pro preview (remote/branch/force) mostrado antes da
  // confirmação.
  //
  // `mcp__sarah-code__create_pull_request` (Fase 6) fica DE FORA pelo
  // MESMO motivo de `git_push` — na prática É um `git_push` de uma
  // branch (feito por dentro da própria tool) antes de abrir o PR, só
  // que sem o agente precisar chamar as duas tools separadamente. Sem
  // exceção, mesmo sendo "só abrir um PR" — dar push de qualquer coisa
  // pro GitHub nunca é baixo risco neste projeto.
  //
  // Base44 (conector nativo `mcp__claude_ai_Base44__*`, Fase 5 parte
  // 2): fica DE FORA de propósito, igual git_push — NENHUMA das tools
  // desse conector entra aqui. Não é sobre destrutividade (várias são
  // só leitura, ex. `get_app_status`), é sobre custo: Base44 é um
  // serviço externo pago (conta premium), então qualquer chamada
  // precisa de confirmação explícita do usuário, nunca decidida
  // sozinha pelo agente. Ver `FORCE_HIGH_RISK` logo abaixo — reforço
  // redundante de propósito, pra continuar valendo mesmo que algum dia
  // alguém adicione uma tool do Base44 aqui por engano.
]);

/**
 * Reforço redundante sobre `LOW_RISK_TOOLS`: mesmo que uma tool do
 * Base44 acabe entrando na lista acima por engano no futuro, este
 * padrão força alto risco de qualquer forma — o Gateway nunca deixa
 * uma chamada a `mcp__claude_ai_Base44__*` passar em silêncio.
 * Nenhuma outra tool deste projeto precisa disso hoje (é fail-safe por
 * padrão), mas Base44 ganhou reforço explícito por ser a primeira
 * integração deste projeto que custa dinheiro de verdade pro usuário.
 */
const FORCE_HIGH_RISK = [/^mcp__claude_ai_Base44__/];

/**
 * Fase 7 parte 3 — nuance no risco médio, primeira tool: `run_command`.
 * DECISÃO tomada (não proposta — ver docs/architecture.md pro
 * raciocínio completo de por que esta forma e não outras): risco
 * MÉDIO nunca depende de histórico/confiança acumulada, só do
 * CONTEÚDO da chamada atual, avaliado do zero a cada vez — o motivo
 * de existir é justamente impedir que um `rm` real se esconda atrás
 * de um histórico bom de chamadas anteriores.
 *
 * Uma tool médio-risco confirma por padrão, IGUAL alto risco — a
 * diferença de "médio" pra "alto" não é "confirma menos", é (a)
 * fricção mais leve na hora de confirmar (ver `ConfirmFn`/apps de
 * interface) e (b) a EXISTÊNCIA de uma allowlist que permite auto-
 * aprovar certas chamadas, coisa que risco alto nunca tem (git push,
 * envio de e-mail, forget de memória continuam SEMPRE confirmando,
 * sem exceção nenhuma — essa é a fronteira real entre médio e alto,
 * não o nome do nível).
 */
const MEDIUM_RISK_TOOLS = new Set<string>([
  "mcp__sarah-code__run_command",
  // FaceTime (Fase 8): liga de verdade pra alguém — não é destrutivo/
  // irreversível como git push ou enviar e-mail (não mereceria o
  // alarme de alto risco), mas também não é zero-fricção como uma
  // leitura (mereceria mais que baixo risco). DIFERENTE de
  // `run_command`, esta tool NÃO tem entrada nenhuma em
  // `isAutoApprovedMediumRisk` — não existe um "alvo seguro" que
  // dispense confirmar, então toda chamada confirma, sempre, sem
  // exceção (mesma garantia de alto risco nesse aspecto específico —
  // só a APRESENTAÇÃO da confirmação é mais leve, ver `ConfirmFn`).
  "mcp__sarah-facetime__call",
]);

/**
 * Comandos considerados seguros o bastante pra `run_command` rodar
 * sem confirmação (mesma fricção de baixo risco), mesmo sendo risco
 * médio por padrão — leitura/build/teste, nada que escreva ou apague
 * fora do próprio código-fonte do projeto. Lista inicial pequena DE
 * PROPÓSITO (mais fácil auditar 9 padrões do que 30) — cresce só com
 * critério, nunca "pra parar de pedir confirmação".
 *
 * Cada padrão casa o COMEÇO do comando (verbo + argumentos fixos, com
 * fronteira de palavra logo depois — `\s` ou fim de string): `git log
 * --oneline -20` casa com `git log`, mas um hipotético `git logout`
 * não casaria com `git log` sozinho graças à fronteira.
 */
const RUN_COMMAND_ALLOWLIST: RegExp[] = [
  /^ls(\s|$)/,
  /^pwd(\s|$)/,
  /^cat(\s|$)/,
  /^npm\s+test(\s|$)/,
  /^npm\s+run\s+build(\s|$)/,
  /^npm\s+run\s+dev(\s|$)/,
  /^git\s+status(\s|$)/,
  /^git\s+log(\s|$)/,
  /^git\s+diff(\s|$)/,
];

/**
 * Metacaracteres de shell que permitem ENCADEAR ou REDIRECIONAR outro
 * comando além do primeiro — `;`, `&&`, `||`, `|`, backtick, `$(...)`,
 * `>`, `>>`, `<`, quebra de linha. Esta é a defesa real contra o
 * cenário que motivou pedir classificação por CONTEÚDO em vez de
 * confiar em histórico: sem checar isto, `ls; rm -rf .` passaria pela
 * allowlist só por COMEÇAR com `ls` — um `rm` de verdade escondido
 * atrás de um prefixo com "histórico bom". Qualquer um destes símbolos
 * tira o comando da allowlist INTEIRA, mesmo que o resto pareça
 * inofensivo — não tenta entender o resto do comando, só recusa com
 * segurança (cai pra risco médio normal, confirma).
 */
const SHELL_CHAINING_PATTERN = /[;&|`\n<>]|\$\(/;

function isAllowlistedCommand(command: string): boolean {
  const trimmed = command.trim();
  if (SHELL_CHAINING_PATTERN.test(trimmed)) return false;
  return RUN_COMMAND_ALLOWLIST.some((pattern) => pattern.test(trimmed));
}

/**
 * Classifica pelo NOME da tool + `input` da chamada — nunca por
 * histórico/confiança acumulada (Fase 7 parte 3: avaliado do zero a
 * cada chamada, de propósito). `input` só importa pra `run_command`
 * hoje (decide low/medium/high igual, mas quem decide se uma chamada
 * MÉDIA auto-aprova é `isAutoApprovedMediumRisk`, função separada —
 * `classifyRisk` sempre devolve o TIER real, mesmo quando a chamada
 * específica vai rodar sem perguntar).
 */
export function classifyRisk(toolName: string, input?: unknown): RiskLevel {
  if (FORCE_HIGH_RISK.some((pattern) => pattern.test(toolName))) return "high";
  if (MEDIUM_RISK_TOOLS.has(toolName)) return "medium";
  return LOW_RISK_TOOLS.has(toolName) ? "low" : "high";
}

/**
 * Só chamada pra risco MÉDIO (baixo sempre auto-aprova, alto nunca
 * auto-aprova — nem chega a ser chamada pra ele, ver `createGateway`).
 * Decide se ESTA chamada específica roda direto (mesma fricção de
 * baixo risco) ou pausa pra confirmar (fricção mais leve que alto
 * risco, mas ainda pausa). A checagem de conteúdo mora AQUI, não
 * dentro da tool — mesmo princípio de sempre: nenhuma tool decide o
 * próprio risco.
 */
function isAutoApprovedMediumRisk(toolName: string, input: unknown): boolean {
  if (toolName === "mcp__sarah-code__run_command") {
    const command = (input as { command?: unknown } | null)?.command;
    return typeof command === "string" && isAllowlistedCommand(command);
  }
  return false;
}

/**
 * Formatador opcional pra melhorar a exibição da confirmação de alto
 * risco de uma tool específica — em vez do JSON cru do input (que pra
 * `send_draft`, por exemplo, seria só `{"draftId": "r123..."}`, sem
 * dizer PRA QUEM nem O QUÊ está sendo enviado). Recebe o nome
 * qualificado da tool e o input; devolve o texto pronto pra mostrar,
 * ou `null` (ou lança) pra cair no fallback padrão (JSON cru). Quem
 * decide QUAL tool merece um formatador melhor é `packages/core`, que
 * é o único lugar que já conhece todos os pacotes de tool — este
 * pacote (`@sarah/permissions`) continua sem depender de nenhum deles
 * diretamente, só chama o que for injetado.
 */
export type FormatConfirmationInput = (toolName: string, input: unknown) => Promise<string | null>;

/**
 * Função que decide, na prática, "pergunta e espera resposta" — é o
 * único pedaço deste pacote que sabe que existe uma INTERFACE (seja
 * ela qual for) do outro lado. `@sarah/permissions` não amarra mais
 * essa decisão a `readline`/terminal: recebe o nome da tool, o input
 * cru e o `preview` já formatado (resultado de `formatConfirmationInput`,
 * ou `null` se não houver formatador ou ele falhar) e devolve
 * `true`/`false`. Quem constrói o Gateway (`createGateway`) é
 * obrigado a fornecer uma implementação — não existe um padrão
 * universal sensato (terminal, menu bar, notificação do sistema são
 * mecanismos completamente diferentes de pedir "s/n" pro usuário).
 *
 * Fase 0-3: `apps/cli` fornece a única implementação que existe,
 * baseada em `readline` (mesmo texto/formato de sempre). Fase 4
 * (interface gráfica) acrescenta uma segunda implementação (dialog/
 * janela do Electron) sem este pacote precisar saber que ela existe —
 * mesmo princípio de injeção já usado pra `formatConfirmationInput`.
 *
 * Fase 7 parte 3: ganhou o parâmetro `risk` (`"medium"` ou `"high"` —
 * nunca `"low"`, que nunca chega a chamar `confirm` pra começo de
 * conversa) pra cada implementação poder apresentar a pergunta de um
 * jeito PROPORCIONAL: risco alto continua com a fricção dramática de
 * sempre; risco médio pausa e pergunta do mesmo jeito (nunca roda sem
 * perguntar só por ser "menos grave"), mas com apresentação mais leve
 * — sem o aviso "ALTO RISCO", cor/ícone/som menos alarmante conforme a
 * interface (ver `apps/cli`/`apps/menubar`).
 */
export type ConfirmFn = (toolName: string, input: unknown, preview: string | null, risk: "medium" | "high") => Promise<boolean>;

export interface DecisionEntry {
  toolName: string;
  input: unknown;
  risk: RiskLevel;
  decision: Decision;
  /**
   * Fase 7 parte 2: `toolUseID` que o próprio Agent SDK já passa pro
   * `canUseTool` (terceiro argumento, campo `toolUseID` — confirmado no
   * `sdk.d.ts`, não inventado) — repassado pra `@sarah/audit` conseguir
   * casar esta decisão com o RESULTADO da execução, capturado depois
   * por um hook separado (`PostToolUse`/`PostToolUseFailure`, ver
   * `packages/core`). Este pacote não sabe nada sobre hooks nem sobre
   * o schema do audit log — só repassa o id que já tinha em mãos.
   */
  toolUseId: string;
}

export interface GatewayOptions {
  /** Chamado toda vez que o Gateway decide algo — é aqui que o audit log se conecta. */
  onDecision?: (entry: DecisionEntry) => void;
  /** Ver `FormatConfirmationInput` acima. */
  formatConfirmationInput?: FormatConfirmationInput;
  /** Ver `ConfirmFn` acima — obrigatório, sem valor padrão (não há UI implícita). */
  confirm: ConfirmFn;
}

/**
 * Fábrica do Gateway de permissões. O retorno é passado direto como
 * `options.canUseTool` na chamada a `query()` do Agent SDK — é o ponto
 * de interceptação oficial do SDK para decidir, por chamada, se uma
 * tool pode rodar.
 */
export function createGateway(options: GatewayOptions): CanUseTool {
  return async (toolName, toolInput, callOptions) => {
    const risk = classifyRisk(toolName, toolInput);
    const toolUseId = callOptions.toolUseID;

    // Baixo risco sempre roda direto. Risco MÉDIO só roda direto se
    // ESTA chamada específica bater na allowlist (Fase 7 parte 3) —
    // continua avaliado do zero a cada vez, nunca por histórico. Risco
    // alto nunca entra aqui, sem exceção nenhuma.
    const autoApprove = risk === "low" || (risk === "medium" && isAutoApprovedMediumRisk(toolName, toolInput));
    if (autoApprove) {
      options.onDecision?.({ toolName, input: toolInput, risk, decision: "auto-allow", toolUseId });
      return { behavior: "allow", updatedInput: toolInput } satisfies PermissionResult;
    }

    let preview: string | null = null;
    if (options.formatConfirmationInput) {
      try {
        preview = await options.formatConfirmationInput(toolName, toolInput);
      } catch {
        // Falha ao buscar/formatar o preview (ex.: draft já foi apagado)
        // não deve impedir a confirmação — cai pro `null` (a UI injetada
        // decide o próprio fallback, ex.: mostrar o JSON cru do input).
        preview = null;
      }
    }

    // `risk` aqui só pode ser "medium" (sem allowlist) ou "high" — nunca
    // "low", que já saiu pelo `autoApprove` acima.
    const confirmRisk: "medium" | "high" = risk === "high" ? "high" : "medium";
    const approved = await options.confirm(toolName, toolInput, preview, confirmRisk);
    options.onDecision?.({
      toolName,
      input: toolInput,
      risk,
      decision: approved ? "confirmed" : "denied",
      toolUseId,
    });

    if (approved) {
      return { behavior: "allow", updatedInput: toolInput } satisfies PermissionResult;
    }

    return {
      behavior: "deny",
      message: `O usuário negou a execução desta ação de ${confirmRisk === "high" ? "alto" : "médio"} risco.`,
    } satisfies PermissionResult;
  };
}
