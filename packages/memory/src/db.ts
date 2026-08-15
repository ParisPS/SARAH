import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { embed, isVoyageConfigured, l2DistanceToCosineSimilarity, normalize } from "./embeddings.js";

export type MemoryCategory = "fato" | "preferencia";

export interface MemoryEntry {
  content: string;
  category: MemoryCategory;
}

export interface MemoryRow extends MemoryEntry {
  id: number;
  createdAt: string;
}

export interface SimilarMemory {
  row: MemoryRow;
  /** Similaridade de cosseno, 0 a 1 — quanto maior, mais parecido. */
  similarity: number;
}

interface MemoryRowRaw {
  id: number;
  content: string;
  category: MemoryCategory;
  created_at: string;
}

function fromRaw(r: MemoryRowRaw): MemoryRow {
  return { id: r.id, content: r.content, category: r.category, createdAt: r.created_at };
}

/**
 * Converte a query em linguagem natural do usuário numa expressão FTS5
 * segura: cada token vira uma frase entre aspas (`"token"`), unidos por
 * `OR`. Evita dois problemas reais testados isoladamente antes de virar
 * código: (1) sintaxe FTS5 quebrando com palavras reservadas do próprio
 * FTS5 (AND/OR/NOT/NEAR) ou pontuação — aspas tratam qualquer token como
 * termo literal, nunca como operador; (2) sem isso, uma pergunta com "?"
 * ou outra pontuação no fim quebraria a query inteira. Retorna `null` se
 * não sobrar nenhum token (string vazia/só pontuação) — quem chama trata
 * isso como "sem busca por palavra-chave".
 */
function toFtsQuery(raw: string): string | null {
  const tokens = raw
    .normalize("NFKC")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ");
}

// Quantos vizinhos mais próximos buscar no índice vetorial antes de
// filtrar por categoria/excluir o próprio id — ver achado real no
// docs/architecture.md: uma query KNN do sqlite-vec com `k = N` só
// funciona numa SUBQUERY isolada da tabela virtual (testado de
// verdade); filtro por categoria e JOIN com `memories` acontecem DEPOIS,
// na query externa. Um k folgado (bem maior que o volume real de
// memórias de um assistente pessoal) garante que candidatos da
// categoria certa não fiquem de fora só por estarem "atrás" de
// candidatos de outra categoria no ranking geral.
const VEC_CANDIDATE_K = 30;

/**
 * Memória persistente da SARAH (fatos + preferências), em SQLite
 * próprio — mesmo padrão de `data/sarah.db` do audit log
 * (@sarah/audit), um arquivo por responsabilidade.
 *
 * `memories_fts` é uma virtual table FTS5 no modo "external content"
 * (o texto de verdade mora só em `memories.content`; a FTS5 guarda só
 * o índice invertido), sincronizada por trigger em INSERT e DELETE.
 * O trigger de DELETE é obrigatório, não só o de INSERT: sem ele,
 * `forget()` apagaria a linha de `memories` mas deixaria um registro
 * fantasma pesquisável em `memories_fts` pra sempre — testado
 * isoladamente antes de escrever isto (ver docs/architecture.md).
 *
 * FASE 7, PARTE 1 (busca semântica): `memories_vec` é uma segunda
 * virtual table, desta vez do `sqlite-vec` (extensão de busca
 * vetorial pra SQLite — CONFIRMADA viável rodando de verdade nesta
 * máquina, mas registrada como pré-v1/alpha pela própria documentação
 * oficial, "expect breaking changes"). DIFERENTE da FTS5 acima, ela
 * NÃO é sincronizada por trigger de INSERT — gerar um embedding é uma
 * chamada de REDE assíncrona (Voyage AI), e um trigger SQL não pode
 * esperar isso. Por isso `remember()` virou `async`: insere a linha
 * em `memories` (síncrono, sempre acontece) e SÓ DEPOIS tenta gerar e
 * gravar o embedding (best-effort — se a chave da Voyage não estiver
 * configurada, ou a chamada falhar, a memória continua salva e
 * buscável por palavra-chave, só fica de fora da busca semântica até
 * um `backfillEmbeddings()` futuro conseguir preenchê-la). O trigger
 * de DELETE, ao contrário, é síncrono de verdade (só remove uma linha
 * já existente) e por isso continua sendo um trigger SQL normal, sem
 * precisar de rede.
 *
 * A extensão é carregada com `try/catch` explícito: se falhar (build
 * incompatível, binário pré-compilado ausente pra esta plataforma),
 * `vecAvailable` vira `false` e toda a camada de busca semântica
 * degrada silenciosamente pra "indisponível" — `memory.recall`
 * continua funcionando só com FTS5 (comportamento de sempre, nunca
 * quebra por causa de uma dependência experimental).
 *
 * BUG REAL encontrado rodando o app de verdade (não só
 * `createSarahSession()` isolado, que foi o que validou a Fase 7
 * parte 1 originalmente — a lacuna de validação era exatamente essa:
 * o processo REAL do usuário é `apps/menubar/src/daemon.ts`, um
 * processo filho de vida longa, um `MemoryStore`/uma única conexão
 * por sessão do app): a PRIMEIRA versão desta classe sincronizava
 * `memories_vec` num DELETE de `memories` via TRIGGER SQL (mesmo
 * padrão do trigger de DELETE da FTS5 acima). Um trigger, uma vez
 * criado, fica gravado no ESQUEMA DO ARQUIVO .db pra sempre — não é
 * "por conexão" como `vecAvailable`. Então, se uma conexão ANTERIOR
 * (ou uma sessão anterior do app) conseguiu carregar `sqlite-vec` e
 * criou o trigger, e uma conexão POSTERIOR (nova sessão do app, ou a
 * mesma sessão após algo impedir o carregamento da extensão dessa vez
 * — não importa o motivo exato) tem `vecAvailable = false`, o SQLite
 * ainda assim tenta EXECUTAR o trigger em todo DELETE (trigger roda no
 * nível do motor SQL, não é algo que o código JS possa pular condicionalmente
 * feito o `if (this.vecAvailable)` usado nas outras operações) — e
 * falha com `no such module: vec0`, DENTRO da transação implícita do
 * próprio DELETE, derrubando a remoção inteira: nem `memories`, nem
 * `memories_fts` chegavam a ser apagados (reproduzido de verdade:
 * `memory.forget` numa preferência conflitante presa, duas vezes
 * seguidas, com a linha continuando visível depois). MESMA CLASSE de
 * bug já visto na Fase 2 (trigger de FTS5 faltando causando registro
 * fantasma) — só que invertido: aqui o trigger EXISTE mas depende de
 * um módulo OPCIONAL nem sempre disponível na conexão que o executa.
 *
 * Corrigido de duas partes: (1) `memories_vec` NUNCA mais é
 * sincronizada por trigger SQL — a limpeza vira código JS explícito
 * dentro de `forget()`, guardado por `if (this.vecAvailable)` como
 * qualquer outra operação em `memories_vec`, então nunca bloqueia a
 * remoção real se a extensão não estiver carregada NESTA conexão; (2)
 * uma migração idempotente (`DROP TRIGGER IF EXISTS memories_vec_ad`,
 * ver abaixo) roda incondicionalmente na inicialização, mesmo sem
 * `sqlite-vec` carregado (testado: `DROP TRIGGER` não precisa do
 * módulo registrado) — limpa o trigger legado de bancos como o de
 * produção deste projeto, que já tinham a versão antiga do schema.
 * Uma eventual linha órfã deixada em `memories_vec` (memória apagada
 * numa conexão sem a extensão carregada) nunca aparece de volta em
 * busca nenhuma: tanto `findSimilar` quanto `recall` fazem `JOIN
 * memories m ON m.id = v.rowid` — um INNER JOIN comum, que descarta
 * silenciosamente qualquer rowid de `memories_vec` sem linha
 * correspondente em `memories`. Não é preciso garantir 100% de
 * limpeza pra manter a busca correta, só não deixar a limpeza
 * bloquear a operação principal.
 */
export class MemoryStore {
  private db: Database.Database;
  private vecAvailable: boolean;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content TEXT NOT NULL,
        category TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        content, content='memories', content_rowid='id'
      );
      CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
      END;
      CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.id, old.content);
      END;
      CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category);
    `);

    // Migração idempotente — ver bloco grande de comentário acima da
    // classe: bancos criados pela primeira versão desta fase têm um
    // trigger `memories_vec_ad` que causa "no such module: vec0" em
    // qualquer conexão futura sem `sqlite-vec` carregado. Roda SEMPRE,
    // mesmo antes de tentar carregar a extensão (testado: `DROP
    // TRIGGER` não precisa do módulo vec0 registrado nesta conexão).
    this.db.exec(`DROP TRIGGER IF EXISTS memories_vec_ad;`);

    try {
      sqliteVec.load(this.db);
      this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS memories_vec USING vec0(embedding float[1024])`);
      this.vecAvailable = true;
    } catch (err) {
      console.error(
        `[memory] sqlite-vec não pôde ser carregado nesta máquina — busca semântica fica indisponível, ` +
          `só palavra-chave (FTS5) continua funcionando. Detalhe: ${err instanceof Error ? err.message : String(err)}`
      );
      this.vecAvailable = false;
    }
  }

  /**
   * Grava a memória (sempre) e, best-effort, o embedding dela (só se
   * `sqlite-vec` carregou E `VOYAGE_API_KEY` estiver configurada) —
   * falha ao gerar/gravar o embedding NUNCA impede a memória de ser
   * salva, só a deixa de fora da busca semântica até um backfill.
   */
  async remember(entry: MemoryEntry): Promise<MemoryRow> {
    const createdAt = new Date().toISOString();
    const result = this.db
      .prepare(`INSERT INTO memories (content, category, created_at) VALUES (?, ?, ?)`)
      .run(entry.content, entry.category, createdAt);
    const row: MemoryRow = { id: Number(result.lastInsertRowid), content: entry.content, category: entry.category, createdAt };

    await this.tryEmbed(row.id, row.content);
    return row;
  }

  private async tryEmbed(id: number, content: string): Promise<void> {
    if (!this.vecAvailable || !isVoyageConfigured()) return;
    try {
      // Sempre uma linha NOVA (nunca reembeda um id já presente —
      // `remember()` acabou de criar o id, `backfillEmbeddings()` já
      // filtra por `NOT IN (SELECT rowid FROM memories_vec)`), então
      // um INSERT simples basta — sem depender de `OR REPLACE` ter
      // suporte real em cima do módulo de tabela virtual do sqlite-vec.
      const vector = normalize(await embed(content, "document"));
      this.db.prepare(`INSERT INTO memories_vec(rowid, embedding) VALUES (?, ?)`).run(BigInt(id), JSON.stringify(vector));
    } catch (err) {
      console.error(`[memory] falha ao gerar embedding da memória #${id} (salva normalmente, só sem busca semântica): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Busca por SIMILARIDADE SEMÂNTICA (não palavra-chave) restrita a
   * `category` — usada por `memory.remember` (Fase 7 parte 1) ANTES
   * de gravar, pra detectar uma preferência/fato parecido já existente
   * e evitar empilhar silenciosamente duas versões conflitantes da
   * mesma regra. Devolve o candidato mais parecido acima de
   * `threshold` (similaridade de cosseno, 0 a 1), ou `null` se a busca
   * semântica estiver indisponível (sem sqlite-vec/chave da Voyage) ou
   * nada passar do limiar.
   */
  async findSimilar(content: string, category: MemoryCategory, threshold: number): Promise<SimilarMemory | null> {
    if (!this.vecAvailable || !isVoyageConfigured()) return null;

    let queryVector: number[];
    try {
      queryVector = normalize(await embed(content, "document"));
    } catch (err) {
      console.error(`[memory] falha ao gerar embedding pra checagem de duplicata: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }

    // KNN isolado numa subquery (achado real, ver docs/architecture.md:
    // `k = N` só é aceito quando a tabela virtual é a ÚNICA fonte da
    // query — filtro de categoria/JOIN precisam acontecer por fora).
    const candidates = this.db
      .prepare(
        `SELECT m.id, m.content, m.category, m.created_at, v.distance
         FROM (SELECT rowid, distance FROM memories_vec WHERE embedding MATCH ? AND k = ?) v
         JOIN memories m ON m.id = v.rowid
         WHERE m.category = ?
         ORDER BY v.distance
         LIMIT 1`
      )
      .all(JSON.stringify(queryVector), VEC_CANDIDATE_K, category) as Array<MemoryRowRaw & { distance: number }>;

    const best = candidates[0];
    if (!best) return null;

    const similarity = l2DistanceToCosineSimilarity(best.distance);
    if (similarity < threshold) return null;
    return { row: fromRaw(best), similarity };
  }

  /**
   * Busca por palavra-chave (FTS5) FUNDIDA com busca por similaridade
   * semântica (sqlite-vec), quando disponível — Fase 7 parte 1. Fusão
   * por Reciprocal Rank Fusion (RRF): cada fonte contribui
   * `1 / (60 + posição)` por resultado (60 é a constante clássica do
   * RRF, usada como está na literatura — sem inventar um peso novo
   * pra calibrar); um id que aparece nas DUAS listas soma as duas
   * pontuações. Resolve um problema real de combinar ranks: o "rank"
   * do FTS5 (BM25) e a "distância" do sqlite-vec vivem em escalas
   * totalmente diferentes e incomparáveis — RRF ignora a escala
   * original, só usa a POSIÇÃO de cada resultado dentro da própria
   * lista, então nunca precisa de um fator de conversão arbitrário
   * entre os dois.
   *
   * Sem `query` (pergunta aberta, tipo "o que você sabe sobre mim?"):
   * mesmo comportamento de sempre, mais recentes primeiro — não faz
   * sentido semântico nem por palavra-chave sem um termo pra comparar.
   */
  async recall(query?: string, limit = 20): Promise<MemoryRow[]> {
    const trimmed = query?.trim();
    if (!trimmed) {
      const rows = this.db
        .prepare(`SELECT id, content, category, created_at FROM memories ORDER BY id DESC LIMIT ?`)
        .all(limit) as MemoryRowRaw[];
      return rows.map(fromRaw);
    }

    const ftsQuery = toFtsQuery(trimmed);
    const ftsRows = ftsQuery
      ? (this.db
          .prepare(
            `SELECT m.id, m.content, m.category, m.created_at
             FROM memories_fts f
             JOIN memories m ON m.id = f.rowid
             WHERE memories_fts MATCH ?
             ORDER BY rank
             LIMIT ?`
          )
          .all(ftsQuery, limit) as MemoryRowRaw[])
      : [];

    let vectorRows: MemoryRowRaw[] = [];
    if (this.vecAvailable && isVoyageConfigured()) {
      try {
        const queryVector = normalize(await embed(trimmed, "query"));
        vectorRows = this.db
          .prepare(
            `SELECT m.id, m.content, m.category, m.created_at
             FROM (SELECT rowid, distance FROM memories_vec WHERE embedding MATCH ? AND k = ?) v
             JOIN memories m ON m.id = v.rowid
             ORDER BY v.distance
             LIMIT ?`
          )
          .all(JSON.stringify(queryVector), VEC_CANDIDATE_K, limit) as MemoryRowRaw[];
      } catch (err) {
        console.error(`[memory] busca semântica falhou, seguindo só com palavra-chave: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (ftsRows.length === 0 && vectorRows.length === 0) return [];

    const RRF_K = 60;
    const scoreById = new Map<number, number>();
    const rowById = new Map<number, MemoryRowRaw>();
    for (const [i, r] of ftsRows.entries()) {
      scoreById.set(r.id, (scoreById.get(r.id) ?? 0) + 1 / (RRF_K + i + 1));
      rowById.set(r.id, r);
    }
    for (const [i, r] of vectorRows.entries()) {
      scoreById.set(r.id, (scoreById.get(r.id) ?? 0) + 1 / (RRF_K + i + 1));
      rowById.set(r.id, r);
    }

    const ranked = Array.from(scoreById.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([id]) => rowById.get(id))
      .filter((r): r is MemoryRowRaw => r !== undefined);
    return ranked.map(fromRaw);
  }

  /**
   * `true` se algo foi de fato apagado; `false` se o id não existia.
   *
   * A limpeza de `memories_vec` acontece aqui em JS, DEPOIS do DELETE
   * principal já ter sido confirmado — nunca por trigger SQL (ver
   * comentário grande no topo da classe pro porquê) — e só quando
   * `vecAvailable` nesta conexão, em `try/catch` que nunca propaga:
   * mesmo padrão best-effort já usado em `tryEmbed`, mais uma vez
   * "a operação principal nunca pode ser bloqueada por uma falha na
   * camada de busca semântica, que é opcional".
   */
  forget(id: number): boolean {
    const result = this.db.prepare(`DELETE FROM memories WHERE id = ?`).run(id);
    const removed = result.changes > 0;

    if (removed && this.vecAvailable) {
      try {
        this.db.prepare(`DELETE FROM memories_vec WHERE rowid = ?`).run(BigInt(id));
      } catch (err) {
        console.error(`[memory] falha ao remover embedding da memória #${id} do índice vetorial (memória já removida normalmente de memories/memories_fts): ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return removed;
  }

  /**
   * Todas as memórias de uma categoria, sem paginação — usado só pela
   * injeção determinística de preferências no systemPrompt
   * (packages/core/src/index.ts). SEM CACHE: quem chama busca fresco
   * antes de cada `query()`, mesma lição já registrada no
   * docs/architecture.md sobre o bug de cache do schema do Notion.
   */
  listByCategory(category: MemoryCategory): MemoryRow[] {
    const rows = this.db
      .prepare(`SELECT id, content, category, created_at FROM memories WHERE category = ? ORDER BY id ASC`)
      .all(category) as MemoryRowRaw[];
    return rows.map(fromRaw);
  }

  /** Contagem simples — usada pelo aviso consultivo de crescimento (Fase 7 parte 1, ver `packages/memory/src/index.ts`). */
  countByCategory(category: MemoryCategory): number {
    const row = this.db.prepare(`SELECT COUNT(*) as n FROM memories WHERE category = ?`).get(category) as { n: number };
    return row.n;
  }

  /**
   * Gera embeddings pras memórias que ainda não têm um (nunca tiveram
   * `sqlite-vec`/`VOYAGE_API_KEY` disponíveis quando foram criadas, ou
   * já existiam antes desta fase) — chamado uma vez, em background,
   * logo depois de abrir a store (`createMemoryServer`, ver
   * `packages/memory/src/index.ts`), sem bloquear nada: se falhar (sem
   * chave configurada, por exemplo), simplesmente não preenche nada
   * agora, sem quebrar a inicialização do resto do app.
   *
   * ACHADO REAL testando com uma conta Voyage sem cartão cadastrado
   * (cota reduzida documentada pela própria API: 3 requisições por
   * MINUTO): a primeira versão disparava os embeddings do backfill em
   * sequência SEM pausa nenhuma — pra qualquer usuário com mais de 2-3
   * memórias antigas ainda sem embedding, isso estourava a cota
   * inteira sozinho, competindo com (e derrubando) a checagem de
   * conflito/embedding de um `memory.remember` real do usuário
   * acontecendo ao mesmo tempo (reproduzido de verdade: um teste de
   * ponta a ponta chegou a falhar por causa disso). Corrigido com uma
   * pausa de `BACKFILL_DELAY_MS` entre cada chamada — não elimina o
   * limite (só uma `GOOGLE_API_KEY`... digo, um cartão cadastrado na
   * Voyage faz isso, ver `.env.example`), mas evita que o PRÓPRIO
   * backfill seja a causa de um `memory.remember` do usuário falhar
   * logo depois de abrir o app. Sequencial, nunca em paralelo, pelo
   * mesmo motivo.
   */
  async backfillEmbeddings(): Promise<void> {
    if (!this.vecAvailable || !isVoyageConfigured()) return;
    const missing = this.db
      .prepare(`SELECT id, content, category, created_at FROM memories WHERE id NOT IN (SELECT rowid FROM memories_vec)`)
      .all() as MemoryRowRaw[];
    if (missing.length === 0) return;
    console.error(`[memory] preenchendo embedding de ${missing.length} memória(s) antiga(s) em background (com pausa entre cada uma, pra não estourar a cota da Voyage)...`);
    const BACKFILL_DELAY_MS = 20_000; // ~3 requisições/minuto, o mesmo teto da cota sem cartão cadastrado
    for (const [i, row] of missing.entries()) {
      if (i > 0) await new Promise((resolve) => setTimeout(resolve, BACKFILL_DELAY_MS));
      await this.tryEmbed(row.id, row.content);
    }
    console.error(`[memory] backfill de embeddings concluído.`);
  }

  close(): void {
    this.db.close();
  }
}
