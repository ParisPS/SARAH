import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { runNotesBridge } from "./bridge.js";

/**
 * Apple Notes via JXA (`Application("Notes")`) — mesmo padrão externo
 * de packages/apple-calendar e packages/apple-reminders (tool() +
 * createSdkMcpServer, ponte JXA em ./bridge.ts), mas por baixo é um
 * mecanismo BEM diferente: Notes.app não tem framework público
 * equivalente ao EventKit, só o dicionário de scripting do próprio
 * app. Ver native/notes-bridge.js pros detalhes reais encontrados
 * testando contra o app (título = primeira linha do body, body é HTML
 * de verdade, etc.) — não são os mesmos bugs do EventKit.
 *
 * Escopo travado de propósito, mesmo princípio do apple-reminders: só
 * título, conteúdo em texto simples (opcional) e pasta (opcional) —
 * o que a interface de scripting cobre com confiança. Sem anexos, sem
 * formatação rica, sem tags.
 *
 * Baixo risco (ver LOW_RISK_TOOLS em @sarah/permissions): listar é
 * leitura, criar é aditivo e reversível — não apaga nem sobrescreve
 * nada existente.
 */

const listNotes = tool(
  "list_notes",
  "Lista notas do app Notes/Notas da Apple, mais recentes primeiro, opcionalmente filtrado por " +
    "pasta. Leitura, baixo risco.",
  {
    folderName: z.string().optional().describe("nome da pasta (opcional; todas as pastas se omitido)"),
    limit: z.number().int().positive().max(100).optional().describe("máximo de notas a retornar (padrão 20)"),
  },
  async (args) => {
    const result = await runNotesBridge({ command: "list_notes", ...args });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

const createNote = tool(
  "create_note",
  "Cria uma nota nova no app Notes/Notas da Apple: título, conteúdo em texto simples (opcional) e " +
    "pasta (opcional — usa a pasta padrão se omitida). Ação aditiva e reversível, baixo risco. " +
    "NÃO suporta anexos, formatação rica (negrito, listas, imagens) nem tags — só texto simples. Se " +
    "o usuário pedir algo assim, responda que não é suportado em vez de tentar simular.",
  {
    title: z.string().describe("título da nota"),
    content: z.string().optional().describe("conteúdo em texto simples (opcional)"),
    folderName: z.string().optional().describe("nome da pasta onde criar (opcional; usa a pasta padrão se omitido)"),
  },
  async (args) => {
    const result = await runNotesBridge({ command: "create_note", ...args });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

export const appleNotesServer = createSdkMcpServer({
  name: "sarah-apple-notes",
  tools: [listNotes, createNote],
});

export { checkNotesStatus } from "./status.js";
