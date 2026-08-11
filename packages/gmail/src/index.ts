import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { listRecentEmails } from "./client.js";

/**
 * Gmail (leitura) — OAuth próprio da SARAH via GOOGLE_CLIENT_ID/
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
 * Baixo risco (ver LOW_RISK_TOOLS em @sarah/permissions): escopo
 * OAuth é `gmail.readonly` — leitura pura, sem nenhum efeito
 * colateral possível (não envia, não apaga, não marca como lido).
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

export const gmailServer = createSdkMcpServer({
  name: "sarah-gmail",
  tools: [listRecent],
});

export { runInteractiveAuthFlow } from "./auth-flow.js";
