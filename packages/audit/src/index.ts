import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type RiskLevel = "low" | "high";
export type Decision = "auto-allow" | "confirmed" | "denied";

export interface AuditEntry {
  toolName: string;
  input: unknown;
  risk: RiskLevel;
  decision: Decision;
}

export interface AuditRow extends AuditEntry {
  id: number;
  timestamp: string;
}

/**
 * Log de auditoria append-only. Toda decisão do Gateway de permissões
 * (auto-allow, confirmado ou negado) passa por aqui — é o que responde
 * a perguntas do tipo "SARAH, o que você fez hoje?" nas próximas fases.
 *
 * Fase 0: registra só a DECISÃO. Registrar também o RESULTADO da
 * execução (sucesso/erro) fica pra quando ligarmos um hook de
 * PostToolUse — deixei isso de fora agora porque eu não conseguiria
 * validar o formato exato do payload sem rodar o SDK de verdade.
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
  }

  record(entry: AuditEntry): void {
    this.db
      .prepare(
        `INSERT INTO tool_calls (timestamp, tool_name, input_json, risk, decision)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        new Date().toISOString(),
        entry.toolName,
        JSON.stringify(entry.input),
        entry.risk,
        entry.decision
      );
  }

  recent(limit = 20): AuditRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM tool_calls ORDER BY id DESC LIMIT ?`)
      .all(limit) as Array<{
        id: number;
        timestamp: string;
        tool_name: string;
        input_json: string;
        risk: RiskLevel;
        decision: Decision;
      }>;

    return rows.map((r) => ({
      id: r.id,
      timestamp: r.timestamp,
      toolName: r.tool_name,
      input: JSON.parse(r.input_json),
      risk: r.risk,
      decision: r.decision,
    }));
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
