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

  close(): void {
    this.db.close();
  }
}
