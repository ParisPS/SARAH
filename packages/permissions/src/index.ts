import type { CanUseTool, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

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
]);

export function classifyRisk(toolName: string): RiskLevel {
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

async function askConfirmation(
  toolName: string,
  toolInput: unknown,
  formatConfirmationInput?: FormatConfirmationInput
): Promise<boolean> {
  const rl = readline.createInterface({ input, output });
  console.log(`\n⚠️  Ação de ALTO RISCO solicitada: ${toolName}`);

  let preview: string | null = null;
  if (formatConfirmationInput) {
    try {
      preview = await formatConfirmationInput(toolName, toolInput);
    } catch {
      // Falha ao buscar/formatar o preview (ex.: draft já foi apagado)
      // não deve impedir a confirmação — cai pro JSON cru abaixo.
      preview = null;
    }
  }
  console.log(preview ?? `   Entrada: ${JSON.stringify(toolInput)}`);

  const answer = await rl.question("   Confirmar execução? (s/n) ");
  rl.close();
  return answer.trim().toLowerCase() === "s";
}

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
}

/**
 * Fábrica do Gateway de permissões. O retorno é passado direto como
 * `options.canUseTool` na chamada a `query()` do Agent SDK — é o ponto
 * de interceptação oficial do SDK para decidir, por chamada, se uma
 * tool pode rodar.
 */
export function createGateway(options: GatewayOptions = {}): CanUseTool {
  return async (toolName, toolInput) => {
    const risk = classifyRisk(toolName);

    if (risk === "low") {
      options.onDecision?.({ toolName, input: toolInput, risk, decision: "auto-allow" });
      return { behavior: "allow", updatedInput: toolInput } satisfies PermissionResult;
    }

    const approved = await askConfirmation(toolName, toolInput, options.formatConfirmationInput);
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
