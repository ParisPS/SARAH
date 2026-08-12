import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { runEventKitBridge } from "./bridge.js";

/**
 * Apple Reminders via EventKit — mesmo padrão de
 * packages/apple-calendar/src/index.ts (tool() + createSdkMcpServer,
 * ponte JXA em ./bridge.ts).
 *
 * Escopo travado de propósito: só título, lista (opcional) e
 * data/hora de vencimento (opcional) — os únicos campos que a API
 * PÚBLICA do EventKit (`EKReminder`) expõe. Subtarefas, tags e seções
 * do app Reminders moderno só existem via API privada não
 * documentada — decisão já tomada no início do projeto de não usar
 * isso (exige acesso total ao disco e é frágil a updates do macOS).
 * As descriptions abaixo deixam isso explícito pro agente avisar o
 * usuário em vez de tentar simular.
 *
 * Distinção de "compromisso"/"evento" (Notion Calendar por padrão,
 * Apple Calendar se pedido): "lembrete"/"Reminders" é outra coisa,
 * outro app, outra tool — a description marca isso pro agente não
 * confundir as duas.
 *
 * Baixo risco (ver LOW_RISK_TOOLS em @sarah/permissions): listar é
 * leitura, criar é aditivo e reversível.
 */

const listReminders = tool(
  "list_reminders",
  "Lista os lembretes pendentes (não concluídos) do app Lembretes/Reminders da Apple, opcionalmente " +
    "filtrado por lista. Use esta tool quando o usuário pedir explicitamente 'lembrete' ou " +
    "'Reminders' — é diferente de 'compromisso'/'evento' (isso vai pro Notion Calendar ou Apple " +
    "Calendar, não pra esta tool). Leitura, baixo risco.",
  {
    listName: z
      .string()
      .optional()
      .describe("nome da lista de lembretes (opcional; lista de todas as listas se omitido)"),
  },
  async (args) => {
    const result = await runEventKitBridge({ command: "list_reminders", ...args });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

const createReminder = tool(
  "create_reminder",
  "Cria um lembrete novo no app Lembretes/Reminders da Apple: título, lista (opcional — usa a " +
    "lista padrão se omitida) e data/hora de vencimento (opcional). Ação aditiva e reversível, " +
    "baixo risco. Use esta tool quando o usuário pedir explicitamente 'lembrete' ou 'Reminders' — " +
    "é diferente de 'compromisso'/'evento' (isso vai pro Notion Calendar por padrão, ou Apple " +
    "Calendar se pedido, não pra esta tool). " +
    "NÃO suporta subtarefas, tags nem seções — só existem via API privada não documentada do app " +
    "Reminders moderno, fora de escopo por decisão de projeto. Se o usuário pedir algo assim, " +
    "responda que não é suportado em vez de tentar simular (ex.: não coloque a subtarefa dentro " +
    "do título ou invente uma tag).",
  {
    title: z.string().describe("título do lembrete"),
    listName: z
      .string()
      .optional()
      .describe("nome da lista de lembretes onde criar (opcional; usa a lista padrão se omitido)"),
    dueDate: z.string().optional().describe("data/hora de vencimento, ISO 8601 (opcional)"),
  },
  async (args) => {
    const result = await runEventKitBridge({ command: "create_reminder", ...args });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

export const appleRemindersServer = createSdkMcpServer({
  name: "sarah-apple-reminders",
  tools: [listReminders, createReminder],
});

export { checkRemindersStatus } from "./status.js";
