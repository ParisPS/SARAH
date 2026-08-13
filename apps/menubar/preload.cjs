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
  /**
   * Transcrição da conversa desta sessão (Fase 4 parte 2 — migrou do
   * painel principal, que não mostra mais a lista de mensagens por
   * padrão, pro painel de histórico). Guardada em memória no processo
   * principal, não persistida — mesmo tempo de vida que a lista de
   * mensagens já tinha antes dessa mudança.
   */
  conversationHistory: () => ipcRenderer.invoke("sarah:conversationHistory"),
  /**
   * Voz (Fase 4 parte 2, ver @sarah/voice): `startRecording` começa a
   * gravar (devolve na hora, não espera terminar); `awaitRecording`
   * fica pendurada até a gravação acabar sozinha (silêncio detectado)
   * OU `stopRecording` ser chamado (clique de novo no microfone) —
   * devolve `{ ok, text, language }` (texto e idioma DETECTADO,
   * autônomo) ou `{ ok: false, error }`. `speak` fala um texto na voz
   * do IDIOMA DE SAÍDA escolhido (independente do idioma detectado na
   * entrada) e só resolve quando termina de falar.
   */
  startRecording: () => ipcRenderer.invoke("sarah:startRecording"),
  stopRecording: () => ipcRenderer.invoke("sarah:stopRecording"),
  awaitRecording: () => ipcRenderer.invoke("sarah:awaitRecording"),
  speak: (text, language) => ipcRenderer.invoke("sarah:speak", text, language),
  /**
   * Widget de status (Fase 4 parte 2, etapa 2): `weather` recebe
   * coordenadas já obtidas no renderer (`navigator.geolocation`) e
   * devolve `{ ok, tempC, weatherCode, city, country }` — as chamadas
   * de rede de verdade (Open-Meteo + BigDataCloud) rodam no processo
   * principal, nunca aqui. `openLink` abre uma URL/caminho de arquivo
   * real que apareceu numa resposta da SARAH (link clicável na área
   * de legenda).
   */
  weather: (latitude, longitude) => ipcRenderer.invoke("sarah:weather", latitude, longitude),
  openLink: (link) => ipcRenderer.invoke("sarah:openLink", link),
});
