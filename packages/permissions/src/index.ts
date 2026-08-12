import type { CanUseTool, PermissionResult } from "@anthropic-ai/claude-agent-sdk";

export type RiskLevel = "low" | "high";
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
  // Sandbox de código (Fase 5, parte 1): a garantia de segurança destas
  // cinco tools vem do ISOLAMENTO DO CONTAINER em si — validado de
  // verdade (ver docs/architecture.md) que o container não enxerga o
  // filesystem real do Mac fora da pasta do projeto, não alcança a
  // rede local (só internet), e tem limites reais de CPU/memória.
  // Confirmar por linha de comando/arquivo escrito não acrescentaria
  // segurança nenhuma a isso — por isso todas entram como baixo risco,
  // igual às outras integrações aditivas/reversíveis.
  "mcp__sarah-code__create_project",
  "mcp__sarah-code__write_file",
  "mcp__sarah-code__run_command",
  "mcp__sarah-code__git_commit",
  "mcp__sarah-code__preview",
  // `mcp__sarah-code__git_push` fica DE FORA de propósito — SEMPRE
  // alto risco, sem exceção, mesmo dentro do sandbox. Regra definida
  // desde a primeira mensagem deste projeto: git push/--force nunca é
  // baixo risco, ponto final. Ver formatConfirmationInput em
  // packages/core pro preview (remote/branch/force) mostrado antes da
  // confirmação.
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

export function classifyRisk(toolName: string): RiskLevel {
  if (FORCE_HIGH_RISK.some((pattern) => pattern.test(toolName))) return "high";
  return LOW_RISK_TOOLS.has(toolName) ? "low" : "high";
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
 */
export type ConfirmFn = (toolName: string, input: unknown, preview: string | null) => Promise<boolean>;

export interface DecisionEntry {
  toolName: string;
  input: unknown;
  risk: RiskLevel;
  decision: Decision;
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
  return async (toolName, toolInput) => {
    const risk = classifyRisk(toolName);

    if (risk === "low") {
      options.onDecision?.({ toolName, input: toolInput, risk, decision: "auto-allow" });
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

    const approved = await options.confirm(toolName, toolInput, preview);
    options.onDecision?.({
      toolName,
      input: toolInput,
      risk,
      decision: approved ? "confirmed" : "denied",
    });

    if (approved) {
      return { behavior: "allow", updatedInput: toolInput } satisfies PermissionResult;
    }

    return {
      behavior: "deny",
      message: "O usuário negou a execução desta ação de alto risco.",
    } satisfies PermissionResult;
  };
}
