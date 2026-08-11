import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { MemoryStore } from "./db.js";

export { MemoryStore } from "./db.js";
export type { MemoryCategory, MemoryEntry, MemoryRow } from "./db.js";

/**
 * Memória persistente (fatos + preferências) — sobrevive a reiniciar
 * o `pnpm dev`, diferente do histórico de conversa (que também passou
 * a persistir DENTRO da mesma execução via `resume`, ver
 * packages/core/src/index.ts, mas se perde ao encerrar o processo).
 *
 * `category` é um enum Zod fechado ("fato" | "preferencia"), não
 * texto livre — mesmo motivo do `categoria` do Notion Calendar:
 * `packages/core/src/index.ts` precisa filtrar
 * `category === "preferencia"` de forma confiável pra injeção
 * determinística no systemPrompt; um valor livre digitado errado
 * quebraria esse filtro silenciosamente.
 *
 * DIFERENTE dos outros pacotes de tool (apple-calendar, notion,
 * apple-reminders, gmail), que exportam um `xServer` pronto e
 * autocontido: este pacote exporta uma FACTORY
 * (`createMemoryServer`), porque o core precisa de acesso direto ao
 * `MemoryStore` por trás das tools — não só pra chamar as tools via
 * MCP, mas pra ler `category === "preferencia"` ele mesmo, antes de
 * cada `query()`, e montar o `systemPrompt`. Um único `MemoryStore`
 * (uma única conexão SQLite) é compartilhado entre as tools e essa
 * leitura direta do core, em vez de abrir duas conexões pro mesmo
 * arquivo.
 */
const MEMORY_CATEGORIES = ["fato", "preferencia"] as const;

export interface MemoryServerResult {
  server: McpSdkServerConfigWithInstance;
  store: MemoryStore;
}

export function createMemoryServer(dbPath: string): MemoryServerResult {
  const store = new MemoryStore(dbPath);

  const remember = tool(
    "remember",
    "Guarda um fato ou preferência do usuário PERMANENTEMENTE (sobrevive a reiniciar o processo). " +
      "Baixo risco: ação aditiva, nunca sobrescreve nem apaga nada. Use category=\"preferencia\" pra " +
      "regras de comportamento que devem valer automaticamente dali pra frente (ex.: \"sempre crie " +
      "lembretes na lista Trabalho por padrão\") — preferências guardadas assim já chegam pra você " +
      "automaticamente em toda conversa nova, sem precisar chamar memory.recall antes. Use " +
      "category=\"fato\" pra informação geral sobre o usuário que não muda comportamento de outra " +
      "tool (ex.: \"mora em São Paulo\").",
    {
      content: z.string().min(1).describe("o que guardar, em texto livre"),
      category: z
        .enum(MEMORY_CATEGORIES)
        .describe("\"fato\" pra informação geral, \"preferencia\" pra regra de comportamento futuro"),
    },
    async (args) => {
      const row = store.remember(args);
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, ...row }, null, 2) }] };
    }
  );

  const recall = tool(
    "recall",
    "Busca memórias guardadas anteriormente (fatos e preferências) por palavra-chave. Pra perguntas " +
      "abertas tipo \"o que você sabe sobre mim?\", omita `query` — devolve as memórias mais recentes " +
      "em vez de tentar casar palavra-chave (que falharia numa pergunta genérica sem termo específico). " +
      "Pra buscas específicas, passe `query` com o termo (ex.: \"viagem\" pra achar o que foi guardado " +
      "sobre uma viagem). Baixo risco: leitura pura.",
    {
      query: z.string().optional().describe("palavras-chave pra buscar; omitir lista as mais recentes"),
      limit: z.number().int().positive().max(50).optional().describe("máximo de resultados (padrão 20)"),
    },
    async (args) => {
      const rows = store.recall(args.query, args.limit);
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: true, count: rows.length, memories: rows }, null, 2) }],
      };
    }
  );

  const forget = tool(
    "forget",
    "Apaga PERMANENTEMENTE uma memória guardada, por id — ação destrutiva e irreversível, por isso é " +
      "ALTO risco e pede confirmação antes de rodar (diferente de remember/recall). Use quando o " +
      "usuário pedir explicitamente pra esquecer algo, ou quando algo foi guardado por engano. Se você " +
      "não souber o id, chame memory.recall antes pra descobrir.",
    {
      id: z.number().int().positive().describe("id da memória a apagar, obtido via memory.recall"),
    },
    async (args) => {
      const removed = store.forget(args.id);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { ok: removed, id: args.id, message: removed ? "memória removida" : "id não encontrado" },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  const server = createSdkMcpServer({
    name: "sarah-memory",
    tools: [remember, recall, forget],
  });

  return { server, store };
}
