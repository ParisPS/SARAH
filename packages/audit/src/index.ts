import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type RiskLevel = "low" | "high";
export type Decision = "auto-allow" | "confirmed" | "denied";
/** Ver `recordResult` — `null` até o hook PostToolUse/PostToolUseFailure chegar (ou nunca, em linhas antigas). */
export type CallStatus = "success" | "error";

export interface AuditEntry {
  toolName: string;
  input: unknown;
  risk: RiskLevel;
  decision: Decision;
  /**
   * Fase 7 parte 2 (observabilidade): id da chamada de tool dentro da
   * mensagem do modelo (`toolUseID`, já exposto por `canUseTool` no
   * Agent SDK) — grava aqui na hora da DECISÃO do Gateway (antes da
   * tool rodar) só pra `recordResult` conseguir achar a MESMA linha
   * depois, quando o hook de pós-execução chegar com o resultado.
   * Opcional só por tipagem defensiva (chamadas que não passam pelo
   * `canUseTool`, se algum dia existirem, não teriam este id) — na
   * prática o Gateway sempre fornece.
   */
  toolUseId?: string;
}

export interface AuditRow extends AuditEntry {
  id: number;
  timestamp: string;
  /** `null` = ainda não rodou (hook não chegou) ou é uma linha anterior a esta fase. */
  status: CallStatus | null;
  /** Mensagem real do erro, só quando `status === "error"`. */
  errorMessage: string | null;
}

interface RawRow {
  id: number;
  timestamp: string;
  tool_name: string;
  input_json: string;
  risk: RiskLevel;
  decision: Decision;
  tool_use_id: string | null;
  status: CallStatus | null;
  error_message: string | null;
}

function fromRaw(r: RawRow): AuditRow {
  return {
    id: r.id,
    timestamp: r.timestamp,
    toolName: r.tool_name,
    input: JSON.parse(r.input_json),
    risk: r.risk,
    decision: r.decision,
    toolUseId: r.tool_use_id ?? undefined,
    status: r.status,
    errorMessage: r.error_message,
  };
}

/**
 * Log de auditoria append-only. Toda decisão do Gateway de permissões
 * (auto-allow, confirmado ou negado) passa por aqui — é o que responde
 * a perguntas do tipo "SARAH, o que você fez hoje?" nas próximas fases.
 *
 * Fase 0: registrava só a DECISÃO (o que o Gateway decidiu ANTES da
 * tool rodar) — uma chamada aprovada que depois falhasse por erro de
 * API/timeout/dado inválido ficava invisível aqui, mesmo tendo sido
 * registrada. Fase 7 parte 2: `status`/`error_message` capturam o
 * RESULTADO real da execução, preenchidos por `recordResult` — chamado
 * pelos hooks `PostToolUse`/`PostToolUseFailure` do Agent SDK em
 * `packages/core` (ver comentário lá pro porquê esse é o ponto certo,
 * em vez do Gateway ou de cada tool individual). Migração idempotente
 * abaixo: bancos já existentes (como o de produção deste projeto)
 * ganham as colunas novas sem perder nenhuma linha; linhas gravadas
 * antes desta fase ficam com `status = NULL` pra sempre — não é um erro,
 * é "a execução não foi observada", diferente de `status = 'error'`.
 */
export class AuditLog {
  private db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tool_calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        input_json TEXT NOT NULL,
        risk TEXT NOT NULL,
        decision TEXT NOT NULL
      )
    `);

    // Migração idempotente — `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`
    // existe só a partir do SQLite 3.35 (2021); em vez de assumir a
    // versão embutida no `better-sqlite3` desta máquina, confere via
    // `PRAGMA table_info` (sempre disponível) e só adiciona o que
    // realmente falta — seguro rodar em todo `new AuditLog()`, mesmo
    // depois que as colunas já existirem.
    const columns = new Set((this.db.prepare(`PRAGMA table_info(tool_calls)`).all() as Array<{ name: string }>).map((c) => c.name));
    if (!columns.has("tool_use_id")) this.db.exec(`ALTER TABLE tool_calls ADD COLUMN tool_use_id TEXT`);
    if (!columns.has("status")) this.db.exec(`ALTER TABLE tool_calls ADD COLUMN status TEXT`);
    if (!columns.has("error_message")) this.db.exec(`ALTER TABLE tool_calls ADD COLUMN error_message TEXT`);
  }

  record(entry: AuditEntry): void {
    this.db
      .prepare(
        `INSERT INTO tool_calls (timestamp, tool_name, input_json, risk, decision, tool_use_id)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        new Date().toISOString(),
        entry.toolName,
        JSON.stringify(entry.input),
        entry.risk,
        entry.decision,
        entry.toolUseId ?? null
      );
  }

  /**
   * Preenche o RESULTADO real de uma chamada já registrada por
   * `record()`, casando pelo mesmo `toolUseId` — chamado pelos hooks
   * `PostToolUse` (status "success") e `PostToolUseFailure` (status
   * "error", com a mensagem real) em `packages/core`. Se nenhuma linha
   * bater (ex.: uma tool que por algum motivo não passou por
   * `canUseTool`), só loga um aviso — nunca lança, um hook de
   * observabilidade não pode derrubar a conversa por causa disso.
   */
  recordResult(toolUseId: string, status: CallStatus, errorMessage: string | null): void {
    const result = this.db
      .prepare(`UPDATE tool_calls SET status = ?, error_message = ? WHERE tool_use_id = ?`)
      .run(status, errorMessage, toolUseId);
    if (result.changes === 0) {
      console.error(`[audit] recordResult: nenhuma linha encontrada pra tool_use_id=${toolUseId} (status=${status}) — resultado descartado, sem linha pra atualizar.`);
    }
  }

  recent(limit = 20): AuditRow[] {
    const rows = this.db.prepare(`SELECT * FROM tool_calls ORDER BY id DESC LIMIT ?`).all(limit) as RawRow[];
    return rows.map(fromRaw);
  }

  /**
   * Últimas `limit` chamadas que de fato FALHARAM na execução
   * (`status = 'error'`) — pro painel "Erros recentes" do dashboard
   * (Fase 7 parte 2). Vazio é o caso comum/esperado (a maioria das
   * chamadas funciona); o painel trata isso como estado normal, não
   * como ausência de dado.
   */
  recentErrors(limit = 10): AuditRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM tool_calls WHERE status = 'error' ORDER BY id DESC LIMIT ?`)
      .all(limit) as RawRow[];
    return rows.map(fromRaw);
  }

  /**
   * Tools cujas últimas `threshold` chamadas OBSERVADAS (`status`
   * conhecido — ignora linhas antigas/nunca capturadas, `status IS
   * NULL`) foram TODAS erro — sinal de falha REPETIDA, não uma falha
   * isolada (Fase 7 parte 2, peça 3: alertas proativos). Olha tool a
   * tool, não globalmente: uma sequência de erros de tools DIFERENTES
   * intercaladas nunca conta pra nenhuma delas — 3 falhas seguidas de
   * `sarah-figma` misturadas com sucessos de `sarah-gmail` no meio não
   * disparam nada pro Gmail. Dataset pequeno (uso pessoal, não
   * empresarial) — agregação simples em JS por tool, sem SQL exótico,
   * mesmo estilo de `riskCounts`/`countByServer` já usados aqui.
   */
  repeatedFailures(threshold = 3): Array<{ toolName: string; count: number; lastError: string; lastTimestamp: string }> {
    const toolNames = (
      this.db.prepare(`SELECT DISTINCT tool_name FROM tool_calls WHERE status IS NOT NULL`).all() as Array<{ tool_name: string }>
    ).map((r) => r.tool_name);

    const results: Array<{ toolName: string; count: number; lastError: string; lastTimestamp: string }> = [];
    for (const toolName of toolNames) {
      const rows = this.db
        .prepare(`SELECT status, error_message, timestamp FROM tool_calls WHERE tool_name = ? AND status IS NOT NULL ORDER BY id DESC LIMIT ?`)
        .all(toolName, threshold) as Array<{ status: CallStatus; error_message: string | null; timestamp: string }>;
      if (rows.length < threshold) continue;
      if (rows.every((r) => r.status === "error")) {
        results.push({
          toolName,
          count: rows.length,
          lastError: rows[0].error_message ?? "",
          lastTimestamp: rows[0].timestamp,
        });
      }
    }
    return results;
  }

  /**
   * Contagem real de baixo vs alto risco — pro painel "proporção de
   * risco" do dashboard (Fase 4 parte 3.5), substituindo qualquer
   * "confiança"/indicador inventado por uma métrica que já existe de
   * verdade no schema.
   */
  riskCounts(): { low: number; high: number } {
    const rows = this.db.prepare(`SELECT risk, COUNT(*) as n FROM tool_calls GROUP BY risk`).all() as Array<{
      risk: RiskLevel;
      n: number;
    }>;
    const counts = { low: 0, high: 0 };
    for (const row of rows) counts[row.risk] = row.n;
    return counts;
  }

  /**
   * Quantas chamadas por INTEGRAÇÃO (servidor MCP), extraído do
   * `tool_name` (formato `mcp__<server>__<tool>`, ver
   * `packages/core`) — pro painel "atividade por categoria". Tools
   * que não seguem esse formato (ex.: `AskUserQuestion`, nativa do
   * Agent SDK) entram com o próprio nome cru, não descartadas.
   */
  countByServer(): Array<{ server: string; count: number }> {
    const rows = this.db.prepare(`SELECT tool_name FROM tool_calls`).all() as Array<{ tool_name: string }>;
    const counts = new Map<string, number>();
    for (const row of rows) {
      const match = row.tool_name.match(/^mcp__([a-z0-9-]+)__/i);
      const server = match ? match[1] : row.tool_name;
      counts.set(server, (counts.get(server) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .map(([server, count]) => ({ server, count }))
      .sort((a, b) => b.count - a.count);
  }

  /**
   * Chamadas por hora nas últimas `hours` horas — pro painel
   * "atividade recente" (gráfico). Preenche as horas SEM nenhuma
   * chamada com `count: 0` (em vez de simplesmente omitir), pra um
   * gráfico de barras não "pular" horas silenciosamente — mais
   * honesto sobre onde realmente não houve atividade.
   */
  hourlyBuckets(hours = 24): Array<{ hourStart: string; count: number }> {
    const since = new Date(Date.now() - hours * 60 * 60 * 1000);
    const rows = this.db
      .prepare(`SELECT timestamp FROM tool_calls WHERE timestamp >= ?`)
      .all(since.toISOString()) as Array<{ timestamp: string }>;

    const buckets = new Map<string, number>();
    const now = new Date();
    for (let i = hours - 1; i >= 0; i--) {
      const hourStart = new Date(now.getTime() - i * 60 * 60 * 1000);
      hourStart.setMinutes(0, 0, 0);
      buckets.set(hourStart.toISOString(), 0);
    }
    for (const row of rows) {
      const hourStart = new Date(row.timestamp);
      hourStart.setMinutes(0, 0, 0);
      const key = hourStart.toISOString();
      if (buckets.has(key)) buckets.set(key, (buckets.get(key) ?? 0) + 1);
    }
    return Array.from(buckets.entries()).map(([hourStart, count]) => ({ hourStart, count }));
  }

  close(): void {
    this.db.close();
  }
}
