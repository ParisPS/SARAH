import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as readline from "node:readline";
import { randomUUID } from "node:crypto";
import { createSarahSession, type OutputLanguage } from "@sarah/core";
import type { ConfirmFn } from "@sarah/permissions";

/**
 * "sarah-daemon" — processo FILHO, rodado com o Node normal do
 * sistema (via `tsx`, o mesmo mecanismo já usado por `apps/cli`), não
 * com o Node embutido do Electron. Existe só por causa de uma parede
 * real encontrada nesta fase: `better-sqlite3` (usado por
 * @sarah/audit e @sarah/memory) não usa N-API — o binário
 * pré-compilado que baixamos é específico da ABI do Node do sistema
 * (`NODE_MODULE_VERSION 127`), e o Node embutido no Electron 43 usa
 * uma ABI diferente (148), sem prebuilt publicado pra essa versão.
 * Rodar TODO `@sarah/core` (que importa @sarah/audit/@sarah/memory)
 * neste processo separado, fora do Electron, evita esse problema de
 * vez — e qualquer módulo nativo futuro que a mesma restrição afetar.
 *
 * Protocolo: JSON Lines via stdin/stdout (um objeto por linha) — o
 * processo pai (`src/sarah-daemon.ts`, dentro do Electron) manda
 * `{type:"ask", id, prompt}` e recebe de volta
 * `{type:"ask-result", id, ok, text, tools|error}` — `tools` é a
 * lista (deduplicada, na ordem em que rodaram) de `{toolName, risk}`
 * usadas nesse turno, pro selo discreto que `apps/menubar` mostra sob
 * cada resposta (ver `SarahEvent` em @sarah/core). Quando o Gateway
 * (dentro de `createSarahSession`, aqui) precisa confirmar uma ação
 * de alto risco, ESTE processo não sabe mostrar um dialog nativo — só
 * o processo do Electron sabe — então manda
 * `{type:"confirm-request", id, toolName, input, preview}` pro pai e
 * ESPERA a resposta `{type:"confirm-response", id, approved}` antes
 * de deixar o Gateway continuar. `{type:"history", id, limit}` pede
 * as últimas decisões do audit log, respondido com
 * `{type:"history-result", id, entries}`. `{type:"dashboard", id}`
 * pede os dados REAIS do painel (Fase 4 parte 3.5: status de
 * integrações + agregações do audit log, ver `dashboard()` em
 * @sarah/core), respondido com `{type:"dashboard-result", id, data}`.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const ENV_PATH = join(REPO_ROOT, ".env");
if (existsSync(ENV_PATH)) {
  process.loadEnvFile(ENV_PATH);
}

function send(message: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(message) + "\n");
}

const pendingConfirms = new Map<string, (approved: boolean) => void>();

const confirmViaParent: ConfirmFn = (toolName, input, preview) => {
  const id = randomUUID();
  return new Promise<boolean>((resolve) => {
    pendingConfirms.set(id, resolve);
    send({ type: "confirm-request", id, toolName, input, preview });
  });
};

const session = createSarahSession({ confirm: confirmViaParent });

const rl = readline.createInterface({ input: process.stdin });

rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(line);
  } catch {
    // Linha que não é JSON válido (ex.: algum log inesperado de uma
    // dependência escrevendo em stdout por engano) — ignora em vez de
    // derrubar o daemon; o protocolo é só o que a gente controla aqui.
    return;
  }

  if (msg.type === "ask") {
    const id = String(msg.id);
    const prompt = String(msg.prompt ?? "");
    // Fase 4 (Voz), parte 2, ajuste 4: idioma de SAÍDA escolhido no
    // toggle PT/EN de `apps/menubar` — repassado direto pra
    // `session.ask()`, que injeta no `systemPrompt` (ver
    // `packages/core/src/index.ts`). `undefined` (campo ausente ou
    // valor não reconhecido) preserva o comportamento de sempre —
    // nenhuma instrução de idioma é injetada.
    const outputLanguage: OutputLanguage | undefined =
      msg.outputLanguage === "en" || msg.outputLanguage === "pt" ? msg.outputLanguage : undefined;
    (async () => {
      try {
        let text = "";
        // Deduplica por toolName, preservando a ordem da PRIMEIRA vez
        // que cada tool apareceu — se a mesma tool rodar mais de uma
        // vez no turno (ex.: duas chamadas a create_note), o selo
        // mostra ela uma vez só, não repetida.
        const toolsSeen = new Map<string, { toolName: string; risk: string }>();
        for await (const event of session.ask(prompt, outputLanguage)) {
          if (event.type === "text") {
            text += event.text;
          } else {
            if (!toolsSeen.has(event.toolName)) {
              toolsSeen.set(event.toolName, { toolName: event.toolName, risk: event.risk });
            }
          }
        }
        send({ type: "ask-result", id, ok: true, text, tools: Array.from(toolsSeen.values()) });
      } catch (err) {
        send({ type: "ask-result", id, ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    })();
    return;
  }

  if (msg.type === "confirm-response") {
    const id = String(msg.id);
    const resolve = pendingConfirms.get(id);
    if (resolve) {
      pendingConfirms.delete(id);
      resolve(Boolean(msg.approved));
    }
    return;
  }

  if (msg.type === "history") {
    const id = String(msg.id);
    const limit = typeof msg.limit === "number" ? msg.limit : 20;
    send({ type: "history-result", id, entries: session.history(limit) });
    return;
  }

  if (msg.type === "dashboard") {
    const id = String(msg.id);
    session
      .dashboard()
      .then((data) => send({ type: "dashboard-result", id, data }))
      .catch((err) => send({ type: "dashboard-result", id, error: err instanceof Error ? err.message : String(err) }));
  }
});

send({ type: "ready" });

// Fase 5: `close()` virou async (precisa esperar containers de projeto
// pararem de verdade, não só o SQLite) — `shutdown()` espera antes de
// `process.exit`, senão um container de projeto podia ficar órfão se o
// processo morresse no meio do `podman stop`.
async function shutdown(): Promise<void> {
  await session.close();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
// Se o pai (Electron) morrer sem mandar SIGTERM, o stdin fecha — mesmo
// tratamento: encerra a sessão de forma limpa em vez de ficar órfão.
process.stdin.on("close", shutdown);
