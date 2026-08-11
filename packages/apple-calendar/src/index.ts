import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { runEventKitBridge } from "./bridge.js";

/**
 * Primeira integração real (Fase 1): Apple Calendar via EventKit.
 * Mesmo formato de packages/fixtures/src/index.ts — só troca o
 * `execute` por uma chamada à ponte JXA em ./bridge.ts.
 *
 * As duas tools são de baixo risco (ver LOW_RISK_TOOLS em
 * @sarah/permissions): listar é leitura, criar é aditivo e
 * reversível (não apaga nem sobrescreve nada existente).
 */

const listEvents = tool(
  "list_events",
  "Lista os eventos do Calendário da Apple num período (leitura, baixo risco).",
  {
    startDate: z.string().describe("início do período, ISO 8601 (ex.: 2026-08-10T00:00:00Z)"),
    endDate: z.string().describe("fim do período, ISO 8601 (ex.: 2026-08-11T00:00:00Z)"),
  },
  async (args) => {
    const result = await runEventKitBridge({ command: "list_events", ...args });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

const createEvent = tool(
  "create_event",
  "Cria um evento novo no Calendário da Apple (EventKit). Ação aditiva e reversível — não apaga " +
    "nem sobrescreve nenhum evento existente, por isso é baixo risco. " +
    "O calendário PRINCIPAL do usuário é o Notion Calendar (notion.create_event) — só use ESTA " +
    "tool quando o usuário disser explicitamente 'Apple Calendar' ou 'calendário da Apple'. " +
    "Se o pedido não especificar qual calendário, ou disser 'Notion'/'Notion Calendar', use " +
    "notion.create_event em vez desta. NUNCA chame as duas tools de criar evento para o mesmo pedido.",
  {
    title: z.string().describe("título do evento"),
    startDate: z.string().describe("início, ISO 8601 (ex.: 2026-08-11T15:00:00Z)"),
    endDate: z.string().describe("fim, ISO 8601 (ex.: 2026-08-11T16:00:00Z)"),
    notes: z.string().optional().describe("notas/descrição opcional"),
    location: z.string().optional().describe("local opcional"),
    calendarName: z
      .string()
      .optional()
      .describe("nome do calendário onde criar (opcional; usa o calendário padrão se omitido)"),
  },
  async (args) => {
    const result = await runEventKitBridge({ command: "create_event", ...args });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

export const appleCalendarServer = createSdkMcpServer({
  name: "sarah-apple-calendar",
  tools: [listEvents, createEvent],
});
