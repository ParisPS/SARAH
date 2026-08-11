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
  // Gmail (leitura): list_recent_emails usa só o escopo OAuth
  // `gmail.readonly` — leitura pura, sem nenhum efeito colateral
  // possível (não envia, não apaga, não marca como lido). Ainda mais
  // claramente baixo risco que list_events/list_reminders.
  "mcp__sarah-gmail__list_recent_emails",
]);

export function classifyRisk(toolName: string): RiskLevel {
  return LOW_RISK_TOOLS.has(toolName) ? "low" : "high";
}

async function askConfirmation(toolName: string, toolInput: unknown): Promise<boolean> {
  const rl = readline.createInterface({ input, output });
  console.log(`\n⚠️  Ação de ALTO RISCO solicitada: ${toolName}`);
  console.log(`   Entrada: ${JSON.stringify(toolInput)}`);
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

    const approved = await askConfirmation(toolName, toolInput);
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
