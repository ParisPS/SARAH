// Preload roda num contexto isolado (contextIsolation: true, ver
// main-process.ts) — CommonJS de propósito, não ESM/TypeScript: é o
// formato mais simples e previsível pra essa camada específica do
// Electron (o preload tem restrições próprias de módulo,
// independentes do resto do app). Só expõe as duas funções que o
// renderer precisa, via contextBridge — o renderer NUNCA tem acesso
// direto a `ipcRenderer`/Node, só ao que for explicitamente exposto
// aqui. Nenhuma lógica de negócio mora neste arquivo, só encanamento.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("sarah", {
  /**
   * Envia um prompt pro processo principal (que chama
   * `SarahSession.ask()` de @sarah/core) e espera a resposta
   * completa. Devolve `{ ok: true, text, tools }` (tools: lista de
   * `{toolName, risk}` usadas nesse turno, pro selo discreto) ou
   * `{ ok: false, error }` — nunca lança, pra o renderer não precisar
   * de try/catch.
   */
  ask: (prompt) => ipcRenderer.invoke("sarah:ask", prompt),
  /** Últimas `limit` decisões do Gateway (painel de histórico). */
  history: (limit) => ipcRenderer.invoke("sarah:history", limit),
  /** Dados reais do dashboard (status de integrações + agregações do audit log). */
  dashboard: () => ipcRenderer.invoke("sarah:dashboard"),
});
