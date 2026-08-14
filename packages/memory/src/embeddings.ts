/**
 * Cliente cru pra API de embeddings da Voyage AI (Fase 7, parte 1) —
 * sem SDK oficial como dependência, mesmo espírito leve dos outros
 * pacotes de tool (`packages/notion/src/client.ts` é o precedente
 * mais direto: só `fetch` global do Node).
 *
 * Voyage AI é o parceiro que a própria Anthropic recomenda pra
 * embeddings (Claude não gera embedding nativamente) — endpoint e
 * modelo conferidos na documentação ATUAL antes de escrever isto, não
 * assumidos de memória: `POST https://api.voyageai.com/v1/embeddings`,
 * modelo `voyage-4-lite` (o mais barato da família `voyage-4`, 200M
 * tokens grátis por conta — de sobra pro volume de fatos/preferências
 * de um assistente pessoal de um usuário só; a qualidade maior de
 * `voyage-4`/`voyage-4-large` não se justifica pra frases curtas como
 * essas). Dimensão padrão do vetor: 1024 (não sobrescrita aqui —
 * simplicidade, um parâmetro a menos pra errar).
 *
 * `inputType`: Voyage recomenda diferenciar `"document"` (texto que
 * vai pro índice — usado ao GRAVAR uma memória) de `"query"` (texto de
 * busca — usado em `memory.recall`) pra melhorar a qualidade do
 * retrieval assimétrico. Já a checagem de conflito/duplicata
 * (`findSimilar` em `db.ts`) compara memória-com-memória, o mesmo TIPO
 * de conteúdo dos dois lados — por isso usa `"document"` nos dois
 * lados ali, não `"query"`.
 */

const VOYAGE_API_URL = "https://api.voyageai.com/v1/embeddings";
const VOYAGE_MODEL = "voyage-4-lite";

export type EmbeddingInputType = "document" | "query";

function getApiKey(): string | null {
  return process.env.VOYAGE_API_KEY?.trim() || null;
}

/** Usado por quem chama pra decidir se vale a pena tentar (evita uma chamada de rede fadada a falhar). */
export function isVoyageConfigured(): boolean {
  return getApiKey() !== null;
}

/**
 * Devolve o vetor de embedding de `text` (1024 números). Lança erro
 * claro se a chave não estiver configurada, ou se a API responder com
 * erro — quem chama (`db.ts`) trata isso como BEST-EFFORT: a memória
 * ainda é salva sem embedding (busca por palavra-chave via FTS5
 * continua funcionando), nunca bloqueia `memory.remember` por causa
 * disso.
 */
export async function embed(text: string, inputType: EmbeddingInputType): Promise<number[]> {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error(
      "VOYAGE_API_KEY não definida. Configure-a no .env (veja .env.example) — busca semântica fica indisponível sem ela."
    );
  }

  const response = await fetch(VOYAGE_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ input: [text], model: VOYAGE_MODEL, input_type: inputType }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Voyage AI respondeu ${response.status}: ${body.slice(0, 300)}`);
  }

  const data = (await response.json()) as { data?: Array<{ embedding?: unknown }> };
  const vector = data.data?.[0]?.embedding;
  if (!Array.isArray(vector) || vector.some((n) => typeof n !== "number")) {
    throw new Error("Voyage AI devolveu uma resposta sem vetor de embedding válido.");
  }
  return vector as number[];
}

/**
 * Normaliza um vetor pra norma 1 (comprimento euclidiano 1) — feito
 * ANTES de gravar no `sqlite-vec` (ver `db.ts`). Com os dois lados da
 * comparação normalizados, a distância L2 que o `sqlite-vec` devolve
 * (métrica padrão da extensão, confirmada rodando de verdade — ver
 * achado no docs/architecture.md) vira conversível pra similaridade de
 * cosseno por uma fórmula direta, sem depender de configurar
 * `distance_metric=cosine` na tabela virtual (sintaxe que pode não
 * existir/mudar entre versões alpha da extensão): pra vetores
 * unitários, ‖a-b‖² = 2 - 2·cos(a,b) ⟹ cos(a,b) = 1 - ‖a-b‖²/2.
 * `l2DistanceToCosineSimilarity` faz essa conversão.
 */
export function normalize(vector: number[]): number[] {
  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
  if (norm === 0) return vector;
  return vector.map((v) => v / norm);
}

/** Ver `normalize` acima pra dedução da fórmula — só vale pra vetores normalizados dos dois lados. */
export function l2DistanceToCosineSimilarity(l2Distance: number): number {
  return 1 - (l2Distance * l2Distance) / 2;
}
