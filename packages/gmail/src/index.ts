import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { listRecentEmails, getMessage, createDraft, replyDraft, sendDraft } from "./client.js";

/**
 * Gmail — OAuth próprio da SARAH via GOOGLE_CLIENT_ID/
 * GOOGLE_CLIENT_SECRET (refresh token guardado no Keychain do macOS,
 * ver keychain.ts/auth-flow.ts). Mesmo formato de packages/notion e
 * packages/apple-calendar (tool() + createSdkMcpServer).
 *
 * Decisão explícita: NUNCA usar o conector nativo Gmail do claude.ai
 * (namespace `claude_ai_Gmail`) — ele está bloqueado em
 * `disallowedTools` (packages/core/src/index.ts), e a description
 * abaixo reforça isso pro agente. Motivo: essa tool própria passa
 * pelo Gateway de permissões e pelo audit log como qualquer outra
 * integração deste projeto; o conector nativo não.
 *
 * Fase 1: só leitura (`list_recent_emails`), escopo `gmail.readonly`.
 * Fase 3 acrescenta `get_message` (corpo completo sob demanda) e
 * `create_draft`/`reply_draft` (rascunhos), precisando também de
 * `gmail.compose` (ver auth-flow.ts pro porquê dos dois escopos
 * juntos, confirmado na documentação oficial da API, não assumido).
 *
 * `send_draft` (mesma Fase 3, decisão deliberada tomada depois das
 * outras três tools já estarem prontas e validadas — não é reversão
 * de "nunca enviar sem decisão consciente", é essa decisão
 * acontecendo): ENVIA um rascunho que já existe. Continua valendo,
 * mais forte que nunca, a regra "nunca compor-e-enviar direto" — não
 * existe (e não vai existir) uma tool que componha e envie no mesmo
 * passo; o fluxo sempre passa por create_draft/reply_draft primeiro,
 * e só depois, se o usuário confirmar de novo, send_draft. Alto risco
 * (fora de LOW_RISK_TOOLS, ver @sarah/permissions) — é a única ação
 * irreversível de e-mail deste projeto; um e-mail enviado não pode
 * ser desenviado. A tela de confirmação mostra o conteúdo do rascunho
 * de forma legível (Para/Assunto/corpo), não só o `draftId` cru — ver
 * `formatConfirmationInput` em packages/core/src/index.ts.
 *
 * Baixo risco (ver LOW_RISK_TOOLS em @sarah/permissions) as quatro
 * primeiras: leitura pura (list_recent_emails/get_message) ou criação
 * de rascunho, aditiva e reversível — apagar um rascunho não afeta
 * ninguém, o e-mail nunca saiu.
 */
const listRecent = tool(
  "list_recent_emails",
  "Lista/resume e-mails recentes do Gmail do usuário (SOMENTE LEITURA — não envia, apaga, " +
    "marca como lido/não lido nem modifica nada). Esta é a tool PRÓPRIA de e-mail da SARAH " +
    "(OAuth próprio, com refresh token no Keychain do macOS) — use ESTA sempre que o pedido " +
    "envolver e-mail/Gmail. NUNCA use o conector nativo Gmail do claude.ai (namespace " +
    "claude_ai_Gmail) — ele fica bloqueado de propósito. Use o parâmetro `query` com a " +
    "sintaxe de busca do Gmail (ex.: 'newer_than:1d' pra hoje, 'newer_than:7d' pra semana, " +
    "'is:unread' pra não lidos, 'from:fulano@exemplo.com'); se omitido, busca os e-mails do " +
    "último dia (newer_than:1d).",
  {
    query: z
      .string()
      .optional()
      .describe("busca no formato de sintaxe do Gmail (ex.: newer_than:1d, is:unread, from:...); padrão: newer_than:1d"),
    maxResults: z
      .number()
      .int()
      .positive()
      .max(50)
      .optional()
      .describe("máximo de e-mails a retornar (padrão 15, teto 50)"),
  },
  async (args) => {
    try {
      const emails = await listRecentEmails(args);
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: true, count: emails.length, emails }, null, 2) }],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ ok: false, error: String((err as Error).message) }, null, 2),
          },
        ],
      };
    }
  }
);

const getMessageTool = tool(
  "get_message",
  "Busca o CORPO COMPLETO de um e-mail específico (SOMENTE LEITURA), pelo `messageId` — diferente " +
    "de list_recent_emails, que só traz um preview curto. Use esta tool quando precisar do conteúdo " +
    "inteiro de um e-mail (ex.: pra ler antes de responder), não em toda listagem. Obtenha o " +
    "`messageId` primeiro via list_recent_emails.",
  {
    messageId: z.string().describe("id da mensagem, obtido via list_recent_emails"),
  },
  async (args) => {
    try {
      const email = await getMessage(args.messageId);
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, email }, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: false, error: String((err as Error).message) }, null, 2) }],
      };
    }
  }
);

const createDraftTool = tool(
  "create_draft",
  "Cria um RASCUNHO novo de e-mail (destinatário, assunto, corpo em texto simples) — SEM thread, " +
    "não é resposta a nada. NUNCA envia — só cria o rascunho, o usuário revisa e envia manualmente " +
    "pelo Gmail. Ação aditiva e reversível (apagar um rascunho não afeta ninguém), baixo risco. " +
    "Use create_draft pra um e-mail novo; use reply_draft em vez desta pra responder um e-mail " +
    "existente (mantém a thread e o assunto corretos).",
  {
    to: z.string().describe("endereço de e-mail do destinatário"),
    subject: z.string().describe("assunto do e-mail"),
    body: z.string().describe("corpo do e-mail, texto simples"),
  },
  async (args) => {
    try {
      const draft = await createDraft(args);
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, draft }, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: false, error: String((err as Error).message) }, null, 2) }],
      };
    }
  }
);

const replyDraftTool = tool(
  "reply_draft",
  "Cria um RASCUNHO DE RESPOSTA a um e-mail existente, pelo `messageId` — mantém a mesma thread e " +
    "o mesmo assunto (com 'Re:' se ainda não tiver), aparecendo como resposta de verdade no Gmail, " +
    "não como e-mail solto. NUNCA envia — só cria o rascunho, o usuário revisa e envia manualmente " +
    "pelo Gmail. Ação aditiva e reversível, baixo risco. Use get_message antes se precisar ler o " +
    "e-mail original pra saber o que responder.",
  {
    messageId: z.string().describe("id do e-mail original a responder, obtido via list_recent_emails/get_message"),
    body: z.string().describe("corpo da resposta, texto simples"),
  },
  async (args) => {
    try {
      const draft = await replyDraft(args);
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, draft }, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: false, error: String((err as Error).message) }, null, 2) }],
      };
    }
  }
);

const sendDraftTool = tool(
  "send_draft",
  "ENVIA um rascunho de e-mail que JÁ EXISTE (criado antes via create_draft ou reply_draft) — o " +
    "e-mail sai de verdade, ação IRREVERSÍVEL. ALTO RISCO: pede confirmação antes de rodar. Esta " +
    "tool NÃO cria nem edita rascunho, só envia um que já existe — pra compor e mandar algo novo, " +
    "primeiro use create_draft ou reply_draft, e só depois send_draft com o `draftId` retornado. " +
    "NUNCA tente compor e enviar no mesmo passo.",
  {
    draftId: z.string().describe("id do rascunho a enviar, obtido via create_draft ou reply_draft"),
  },
  async (args) => {
    try {
      const result = await sendDraft(args.draftId);
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, sent: result }, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: false, error: String((err as Error).message) }, null, 2) }],
      };
    }
  }
);

export const gmailServer = createSdkMcpServer({
  name: "sarah-gmail",
  tools: [listRecent, getMessageTool, createDraftTool, replyDraftTool, sendDraftTool],
});

export { runInteractiveAuthFlow } from "./auth-flow.js";
export { getDraftPreview } from "./client.js";
export type { DraftPreview } from "./client.js";
