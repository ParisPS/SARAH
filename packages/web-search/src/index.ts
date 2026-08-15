import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { okResult, errorResult } from "@sarah/tool-result";
import { searchPrice } from "./client.js";

/**
 * Busca de preços (Fase 9) — primeira capacidade de busca na web da
 * SARAH. Decisão de design explícita: NÃO é destravar a tool nativa
 * `WebSearch` do Agent SDK (que continua bloqueada em
 * `BUILTIN_TOOLS_TO_BLOCK`, packages/core/src/index.ts) pra acesso
 * genérico — é uma tool PRÓPRIA e FOCADA, só pra preço de produto/
 * serviço, consistente com o padrão do resto do projeto (cada
 * integração é específica de um caso de uso, nunca acesso aberto).
 *
 * Implementação via Serper.dev (revenda de resultados do Google
 * Shopping) — ver client.ts pro porquê desse provedor (Bing
 * aposentada, Google Custom Search fechada pra clientes novos, Brave
 * exige cartão de crédito). Busca RAZOÁVEL, não comparação exaustiva
 * de mercado: algumas opções reais com preço e fonte, nunca inventadas
 * — se a busca não achar nada, a tool diz isso claramente, não
 * preenche com um preço estimado/chutado.
 *
 * Baixo risco (LOW_RISK_TOOLS, @sarah/permissions): só leitura/busca,
 * nenhuma ação com efeito colateral nenhum — mesma classe de
 * `list_events`/`list_reminders`.
 */

const searchPriceTool = tool(
  "search_price",
  "Busca preços REAIS de um produto ou serviço na web (via Google Shopping), devolvendo algumas opções " +
    "com título, preço, loja/fonte e link — NUNCA inventa preço nenhum, se não encontrar nada devolve a " +
    "lista vazia. É uma busca RAZOÁVEL (algumas opções pra dar uma noção de preço), não uma comparação " +
    "exaustiva de todo o mercado. Use pra perguntas do tipo \"quanto custa X\"/\"qual o preço de X\"/" +
    "\"quanto tá custando X\". Diferente de qualquer tool de compra — esta tool NUNCA compra nada, só " +
    "informa preços encontrados.",
  {
    item: z.string().min(1).describe("nome do produto/serviço a buscar o preço (ex.: \"Air Fryer Mondial 4L\")"),
    maxResults: z.number().int().positive().max(10).optional().describe("máximo de opções a retornar (padrão 5)"),
  },
  async (args) => {
    try {
      const result = await searchPrice(args);
      return okResult({ query: result.query, count: result.options.length, options: result.options });
    } catch (err) {
      return errorResult(err);
    }
  }
);

export const webSearchServer = createSdkMcpServer({
  name: "sarah-web-search",
  tools: [searchPriceTool],
});

export { checkWebSearchStatus } from "./status.js";
