import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { okResult } from "@sarah/tool-result";
import { MemoryStore } from "./db.js";

export { MemoryStore } from "./db.js";
export type { MemoryCategory, MemoryEntry, MemoryRow, SimilarMemory } from "./db.js";

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
 *
 * FASE 7, PARTE 1 (memória semântica — embeddings Voyage AI +
 * sqlite-vec, ver `db.ts`): resolve as duas notas pendentes deixadas
 * em aberto na Fase 2, sem abrir mão das garantias que motivaram
 * deixá-las pendentes na época:
 *
 * 1. Lista de preferências sem limite: NÃO virou "só injeta
 *    preferências relevantes à pergunta atual" — isso quebraria a
 *    garantia de que uma preferência vale SEMPRE, mesmo num pedido que
 *    não parece relacionado na superfície (`listByCategory` continua
 *    devolvendo TODAS, sem filtro nenhum, ver `packages/core`). Em vez
 *    disso, um teto CONSULTIVO (`PREFERENCE_SOFT_CAP` abaixo): passar
 *    dele nunca bloqueia nem filtra nada — só anexa um aviso no
 *    resultado da tool, pro agente repassar ao usuário sugerindo
 *    revisão. Crescimento fica visível e acionável, sem perder
 *    determinismo.
 * 2. Sem tratamento de duplicata/conflito: `remember` agora busca por
 *    SIMILARIDADE SEMÂNTICA (não só texto idêntico) contra memórias da
 *    MESMA categoria antes de gravar. Achar uma parecida acima de
 *    `CONFLICT_SIMILARITY_THRESHOLD` interrompe a gravação e devolve a
 *    memória conflitante pro agente — que precisa perguntar ao usuário
 *    (via AskUserQuestion, reforçado também no systemPrompt sempre-
 *    injetado, ver `MEMORY_CONFLICT_POLICY_TEXT` em
 *    `packages/core/src/index.ts`) se é pra SUBSTITUIR (memory.forget
 *    na antiga, que já é alto risco/confirmado, + remember de novo com
 *    `force: true`) ou MANTER AS DUAS (remember de novo com
 *    `force: true`, pulando a checagem). `remember` continua baixo
 *    risco sempre — só o `forget` de uma substituição passa pela
 *    confirmação de alto risco de sempre, nada novo aí.
 */
const MEMORY_CATEGORIES = ["fato", "preferencia"] as const;

/** Ver nota 1 no comentário do topo — consultivo, nunca filtra nem bloqueia, só avisa. */
const PREFERENCE_SOFT_CAP = 40;

/**
 * Similaridade de cosseno (0 a 1) acima da qual duas memórias da MESMA
 * categoria são tratadas como "parecidas o bastante pra conflitar".
 *
 * NÃO é um chute — calibrado com embeddings REAIS da Voyage AI (não
 * só teoria) usando exatamente o par de exemplo deste pedido: "sempre
 * crie lembretes na lista Trabalho" vs. "prefiro que lembretes vão
 * pra lista Pessoal" deu cosseno **0,72** (mesmo assunto, conclusão
 * contrária — É um conflito de verdade), enquanto "sempre crie
 * lembretes na lista Trabalho" vs. um assunto sem nenhuma relação
 * ("gosto de café pela manhã") deu **0,55**. A proposta original
 * (0,84, baseada em intuição genérica sobre embeddings) teria deixado
 * o conflito de exemplo passar batido — corrigido depois de medir de
 * verdade, não mantido só porque tinha sido proposto antes. 0,68 fica
 * no meio dos dois pontos medidos, com folga maior do lado de baixo
 * (falso positivo só custa uma pergunta a mais ao usuário; falso
 * negativo deixa duas preferências contraditórias se acumularem
 * silenciosamente — exatamente o bug que esta fase resolve). Ajustável
 * no futuro se o uso real mostrar que está fora do ponto.
 */
const CONFLICT_SIMILARITY_THRESHOLD = 0.68;

export interface MemoryServerResult {
  server: McpSdkServerConfigWithInstance;
  store: MemoryStore;
}

export function createMemoryServer(dbPath: string): MemoryServerResult {
  const store = new MemoryStore(dbPath);

  // Fire-and-forget, de propósito — não atrasa a inicialização do
  // resto do app por causa de uma chamada de rede best-effort (ver
  // `backfillEmbeddings` em `db.ts`). Erros já são logados lá dentro.
  void store.backfillEmbeddings();

  const remember = tool(
    "remember",
    "Guarda um fato ou preferência do usuário PERMANENTEMENTE (sobrevive a reiniciar o processo). " +
      "Baixo risco: ação aditiva, nunca sobrescreve nem apaga nada. Use category=\"preferencia\" pra " +
      "regras de comportamento futuro (ex.: \"sempre crie lembretes na lista Trabalho por padrão\") — " +
      "já chegam automaticamente em toda conversa nova, sem precisar chamar memory.recall antes. Use " +
      "category=\"fato\" pra informação geral que não muda comportamento de outra tool (ex.: \"mora em " +
      "São Paulo\"). " +
      "IMPORTANTE — checagem de duplicata/conflito: por padrão (force ausente/false), esta tool busca " +
      "por SIMILARIDADE SEMÂNTICA contra memórias já guardadas da MESMA categoria antes de salvar. Se " +
      "achar uma parecida, NÃO grava — devolve {conflict: true, existing: {...}} e você precisa " +
      "perguntar ao usuário (AskUserQuestion) se é pra SUBSTITUIR (chame memory.forget no id da " +
      "existente, depois remember de novo com force:true) ou MANTER AS DUAS (chame remember de novo " +
      "com force:true diretamente). NUNCA chame remember com force:true sem antes ter perguntado — " +
      "só depois da resposta do usuário.",
    {
      content: z.string().min(1).describe("o que guardar, em texto livre"),
      category: z
        .enum(MEMORY_CATEGORIES)
        .describe("\"fato\" pra informação geral, \"preferencia\" pra regra de comportamento futuro"),
      force: z
        .boolean()
        .optional()
        .describe(
          "pule a checagem de duplicata/conflito e grave direto — só use depois de perguntar ao usuário " +
            "e ele decidir substituir ou manter as duas (ver descrição da tool)"
        ),
    },
    async (args) => {
      if (!args.force) {
        const similar = await store.findSimilar(args.content, args.category, CONFLICT_SIMILARITY_THRESHOLD);
        if (similar) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    ok: false,
                    conflict: true,
                    existing: similar.row,
                    similarity: Number(similar.similarity.toFixed(3)),
                    message:
                      "Já existe uma memória parecida com esta (mesma categoria, similaridade semântica " +
                      `${similar.similarity.toFixed(2)}). Pergunte ao usuário via AskUserQuestion se é pra ` +
                      "SUBSTITUIR (memory.forget no id existente, depois memory.remember de novo com " +
                      "force:true) ou MANTER AS DUAS (memory.remember de novo com force:true) — não grave " +
                      "sem essa decisão.",
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }
      }

      const row = await store.remember({ content: args.content, category: args.category });

      // Nota 1 (ver comentário do topo): consultivo, nunca bloqueia —
      // só avisa quando o total já ultrapassou o teto.
      let warning: string | undefined;
      if (args.category === "preferencia") {
        const count = store.countByCategory("preferencia");
        if (count > PREFERENCE_SOFT_CAP) {
          warning =
            `Você já tem ${count} preferências guardadas (acima do teto recomendado de ${PREFERENCE_SOFT_CAP}) ` +
            "— considere pedir pra revisar (memory.recall) e remover (memory.forget) as que não fazem mais " +
            "sentido, senão o systemPrompt de cada pedido continua crescendo.";
        }
      }

      return okResult({ ...row, ...(warning ? { warning } : {}) });
    }
  );

  const recall = tool(
    "recall",
    "Busca memórias guardadas anteriormente (fatos e preferências), combinando palavra-chave E " +
      "similaridade semântica (Fase 7 — encontra mesmo quando a pergunta usa palavras diferentes das " +
      "que foram guardadas, ex.: perguntar \"faculdade\" acha uma memória sobre \"universidade\"). Pra " +
      "perguntas abertas tipo \"o que você sabe sobre mim?\", omita `query` — devolve as memórias mais " +
      "recentes em vez de tentar casar termo nenhum. Baixo risco: leitura pura.",
    {
      query: z.string().optional().describe("pergunta ou palavras-chave pra buscar; omitir lista as mais recentes"),
      limit: z.number().int().positive().max(50).optional().describe("máximo de resultados (padrão 20)"),
    },
    async (args) => {
      const rows = await store.recall(args.query, args.limit);
      return okResult({ count: rows.length, memories: rows });
    }
  );

  const forget = tool(
    "forget",
    "Apaga PERMANENTEMENTE uma memória guardada, por id — ação destrutiva e irreversível, por isso é " +
      "ALTO risco e pede confirmação antes de rodar (diferente de remember/recall). Use quando o " +
      "usuário pedir explicitamente pra esquecer algo, ou quando algo foi guardado por engano — inclusive " +
      "como parte de uma SUBSTITUIÇÃO de preferência conflitante (ver descrição de remember): apaga a " +
      "antiga, depois chama remember de novo com force:true pra gravar a nova. Se você não souber o id, " +
      "chame memory.recall antes pra descobrir.",
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
