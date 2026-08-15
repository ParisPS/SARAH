import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { okResult, errorResult } from "@sarah/tool-result";
import { createCalendarEntry } from "./client.js";

/**
 * Notion Calendar — o calendário PRINCIPAL do usuário (banco de dados
 * do Notion). As propriedades título e data são detectadas pelo TIPO,
 * não pelo nome — funciona com "Título"/"Data", "Name"/"Date", ou
 * qualquer outro nome que o usuário tenha usado (ver client.ts).
 * Mesmo formato de packages/fixtures e packages/apple-calendar
 * (tool() + createSdkMcpServer).
 *
 * Desambiguação entre notion.create_event e apple_calendar.create_event:
 * o Agent SDK não tem um roteador central pra isso — a única coisa
 * que o agente enxerga pra decidir qual tool chamar é a `description`
 * de cada uma. Por isso a regra "Notion é padrão, Apple só se pedido
 * explicitamente, nunca as duas juntas" está escrita nas duas
 * descriptions (aqui e em packages/apple-calendar/src/index.ts),
 * como texto simétrico e sem ambiguidade.
 *
 * Baixo risco (ver LOW_RISK_TOOLS em @sarah/permissions): criar
 * página no Notion é aditivo e reversível — não apaga nem sobrescreve
 * nada existente.
 */

/**
 * Opções EXATAS da propriedade Select "Categoria" no banco do
 * usuário — cada uma já tem uma cor configurada no Notion. Por isso é
 * um enum Zod fechado, não `z.string()` livre: se o agente inventasse
 * um valor fora dessa lista, o Notion criaria uma opção nova sem cor
 * associada, quebrando a organização visual já feita.
 */
const CATEGORY_OPTIONS = ["Viagem", "Pessoal", "Saúde", "Estudos", "Trabalho"] as const;

const createEvent = tool(
  "create_event",
  "Cria um compromisso no Notion Calendar (banco de dados do Notion; título e data detectados " +
    "automaticamente pelo tipo da propriedade existente no banco). " +
    "Ação aditiva e reversível — não apaga nem sobrescreve nada, por isso é baixo risco. " +
    "ESTE é o calendário PRINCIPAL do usuário: use esta tool como PADRÃO sempre que o pedido " +
    "não especificar explicitamente qual calendário usar, ou quando o usuário disser " +
    "'Notion' ou 'Notion Calendar' explicitamente. " +
    "NUNCA chame esta tool junto com apple_calendar.create_event para o mesmo pedido — " +
    "são calendários separados de propósito, sem duplicação entre eles. " +
    "Use apple_calendar.create_event em vez desta SÓ quando o usuário disser explicitamente " +
    "'Apple Calendar' ou 'calendário da Apple'. " +
    "Se o usuário mencionar uma categoria (Pessoal, Estudos, Trabalho, Saúde ou Viagem), " +
    "preencha `categoria` com o valor exato correspondente — não invente outra, e não " +
    "preencha se não for mencionada.",
  {
    title: z.string().describe("título do compromisso"),
    date: z
      .string()
      .describe("data/hora de início, ISO 8601 (ex.: 2026-08-11T15:00:00Z ou 2026-08-11 pro dia inteiro)"),
    endDate: z.string().optional().describe("data/hora de fim, ISO 8601 (opcional)"),
    categoria: z
      .enum(CATEGORY_OPTIONS)
      .optional()
      .describe(
        "categoria do compromisso, só uma destas opções exatas (não inventar outra): " +
          CATEGORY_OPTIONS.join(", ")
      ),
  },
  async (args) => {
    try {
      const result = await createCalendarEntry(args);
      return okResult(result);
    } catch (err) {
      return errorResult(err);
    }
  }
);

export const notionServer = createSdkMcpServer({
  name: "sarah-notion",
  tools: [createEvent],
});

export { checkNotionStatus } from "./status.js";
