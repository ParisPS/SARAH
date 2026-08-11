import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type MemoryCategory = "fato" | "preferencia";

export interface MemoryEntry {
  content: string;
  category: MemoryCategory;
}

export interface MemoryRow extends MemoryEntry {
  id: number;
  createdAt: string;
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
 */
export class MemoryStore {
  private db: Database.Database;

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
    `);
  }

  remember(entry: MemoryEntry): MemoryRow {
    const createdAt = new Date().toISOString();
    const result = this.db
      .prepare(`INSERT INTO memories (content, category, created_at) VALUES (?, ?, ?)`)
      .run(entry.content, entry.category, createdAt);
    return { id: Number(result.lastInsertRowid), content: entry.content, category: entry.category, createdAt };
  }

  /**
   * Busca por palavra-chave (FTS5). Sem `query` (ou só pontuação/
   * vazio), devolve as memórias mais recentes em vez de tentar casar
   * palavra-chave — cobre perguntas abertas tipo "o que você sabe
   * sobre mim?", onde não há um termo específico pra buscar (testado
   * isoladamente: um FTS5 MATCH com os tokens de uma pergunta genérica
   * como essa não bate com nada guardado, então a busca por palavra-
   * chave sozinha não resolveria esse caso de uso).
   */
  recall(query?: string, limit = 20): MemoryRow[] {
    const trimmed = query?.trim();
    const ftsQuery = trimmed ? toFtsQuery(trimmed) : null;

    if (!ftsQuery) {
      const rows = this.db
        .prepare(`SELECT id, content, category, created_at FROM memories ORDER BY id DESC LIMIT ?`)
        .all(limit) as MemoryRowRaw[];
      return rows.map(fromRaw);
    }

    const rows = this.db
      .prepare(
        `SELECT m.id, m.content, m.category, m.created_at
         FROM memories_fts f
         JOIN memories m ON m.id = f.rowid
         WHERE memories_fts MATCH ?
         ORDER BY rank
         LIMIT ?`
      )
      .all(ftsQuery, limit) as MemoryRowRaw[];
    return rows.map(fromRaw);
  }

  /** `true` se algo foi de fato apagado; `false` se o id não existia. */
  forget(id: number): boolean {
    const result = this.db.prepare(`DELETE FROM memories WHERE id = ?`).run(id);
    return result.changes > 0;
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

  close(): void {
    this.db.close();
  }
}
