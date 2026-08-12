import { spawn } from "node:child_process";
import * as readline from "node:readline";
import { randomUUID } from "node:crypto";
import type { ConfirmFn } from "@sarah/permissions";

/**
 * Lado PAI do protocolo descrito em `daemon.ts` — roda dentro do
 * processo principal do Electron. Sobe o processo filho (Node comum,
 * via `tsx`, fora da ABI do Electron), fala JSON Lines com ele, e
 * repassa pedidos de confirmação pro `confirm` (dialog nativo) que
 * `main-process.ts` fornece — o filho não sabe nada de Electron, só
 * de `@sarah/core`.
 */

/** Mesma forma de `AuditRow` (@sarah/audit) — copiada aqui, não importada,
 * de propósito: `apps/menubar` não precisa de `@sarah/audit` (nem do
 * `better-sqlite3` por trás dele) como dependência direta, só do
 * FORMATO dos dados que já chegam prontos via JSON do daemon. */
export interface HistoryEntry {
  id: number;
  timestamp: string;
  toolName: string;
  input: unknown;
  risk: "low" | "high";
  decision: "auto-allow" | "confirmed" | "denied";
}

export interface ToolUsage {
  toolName: string;
  risk: "low" | "high";
}

export type AskResult = { ok: true; text: string; tools: ToolUsage[] } | { ok: false; error: string };

/** Mesma forma de `DashboardData`/`IntegrationStatus` (@sarah/core) — copiada
 * aqui pelo mesmo motivo de `HistoryEntry` acima (formato dos dados que já
 * chegam prontos via JSON, sem acoplar `apps/menubar` a `better-sqlite3`). */
export interface IntegrationStatus {
  id: string;
  label: string;
  configured: boolean;
  detail: string;
}
export interface DashboardData {
  integrations: IntegrationStatus[];
  riskCounts: { low: number; high: number };
  categoryCounts: Array<{ server: string; count: number }>;
  hourlyActivity: Array<{ hourStart: string; count: number }>;
}

export interface SarahDaemon {
  ask(prompt: string): Promise<AskResult>;
  history(limit?: number): Promise<HistoryEntry[]>;
  dashboard(): Promise<DashboardData>;
  stop(): void;
}

export function spawnSarahDaemon(tsxBinPath: string, daemonScriptPath: string, confirm: ConfirmFn): SarahDaemon {
  const child = spawn(tsxBinPath, [daemonScriptPath], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  child.stderr.on("data", (chunk: Buffer) => {
    // Erros/avisos do daemon (ex.: stack trace de uma tool) — só loga
    // no console do processo principal, não derruba o app de janela.
    console.error("[sarah-daemon]", chunk.toString().trimEnd());
  });

  child.on("exit", (code, signal) => {
    console.error(`[sarah-daemon] processo filho encerrou (code=${code}, signal=${signal})`);
  });

  const pendingAsks = new Map<string, (result: AskResult) => void>();
  const pendingHistory = new Map<string, (entries: HistoryEntry[]) => void>();
  const pendingDashboard = new Map<string, (data: DashboardData) => void>();

  function sendToChild(message: Record<string, unknown>): void {
    child.stdin.write(JSON.stringify(message) + "\n");
  }

  const rl = readline.createInterface({ input: child.stdout });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line);
    } catch {
      // Mesma defesa do lado filho: linha que não é JSON válido é
      // ignorada, não derruba a ponte.
      return;
    }

    if (msg.type === "ask-result") {
      const id = String(msg.id);
      const resolve = pendingAsks.get(id);
      if (resolve) {
        pendingAsks.delete(id);
        resolve(
          msg.ok
            ? { ok: true, text: String(msg.text ?? ""), tools: (msg.tools as ToolUsage[]) ?? [] }
            : { ok: false, error: String(msg.error ?? "erro desconhecido") }
        );
      }
      return;
    }

    if (msg.type === "history-result") {
      const id = String(msg.id);
      const resolve = pendingHistory.get(id);
      if (resolve) {
        pendingHistory.delete(id);
        resolve((msg.entries as HistoryEntry[]) ?? []);
      }
      return;
    }

    if (msg.type === "dashboard-result") {
      const id = String(msg.id);
      const resolve = pendingDashboard.get(id);
      if (resolve) {
        pendingDashboard.delete(id);
        resolve(
          (msg.data as DashboardData) ?? {
            integrations: [],
            riskCounts: { low: 0, high: 0 },
            categoryCounts: [],
            hourlyActivity: [],
          }
        );
      }
      return;
    }

    if (msg.type === "confirm-request") {
      const id = String(msg.id);
      const toolName = String(msg.toolName);
      const preview = (msg.preview as string | null) ?? null;
      confirm(toolName, msg.input, preview).then((approved) => {
        sendToChild({ type: "confirm-response", id, approved });
      });
    }
  });

  function ask(prompt: string): Promise<AskResult> {
    const id = randomUUID();
    return new Promise((resolve) => {
      pendingAsks.set(id, resolve);
      sendToChild({ type: "ask", id, prompt });
    });
  }

  function history(limit = 20): Promise<HistoryEntry[]> {
    const id = randomUUID();
    return new Promise((resolve) => {
      pendingHistory.set(id, resolve);
      sendToChild({ type: "history", id, limit });
    });
  }

  function dashboard(): Promise<DashboardData> {
    const id = randomUUID();
    return new Promise((resolve) => {
      pendingDashboard.set(id, resolve);
      sendToChild({ type: "dashboard", id });
    });
  }

  function stop(): void {
    child.kill();
  }

  return { ask, history, dashboard, stop };
}
