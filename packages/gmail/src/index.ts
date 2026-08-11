import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { listRecentEmails, getMessage, createDraft, replyDraft } from "./client.js";

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
 * DECISÃO PERMANENTE, desde a primeira mensagem deste projeto: NUNCA
 * implementar uma tool de ENVIAR e-mail. As tools abaixo só leem e
 * criam/atualizam rascunho — nenhuma chama o endpoint de enviar da
 * API do Gmail (ver client.ts). O usuário revisa e envia manualmente
 * pelo Gmail. Isso é garantido pelo CÓDIGO (o endpoint de enviar
 * nunca é chamado em lugar nenhum deste pacote), não pela permissão
 * OAuth — `gmail.compose` tecnicamente também permite enviar do lado
 * da API do Google; não existe escopo mais restrito só-rascunho (ver
 * docs/architecture.md, "limitação aceita").
 *
 * Baixo risco (ver LOW_RISK_TOOLS em @sarah/permissions) as quatro:
 * leitura pura (list_recent_emails/get_message) ou criação de
 * rascunho, aditiva e reversível — apagar um rascunho não afeta
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

export const gmailServer = createSdkMcpServer({
  name: "sarah-gmail",
  tools: [listRecent, getMessageTool, createDraftTool, replyDraftTool],
});

export { runInteractiveAuthFlow } from "./auth-flow.js";
