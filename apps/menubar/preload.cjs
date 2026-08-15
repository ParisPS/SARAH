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
   * completa. `outputLanguage` ("pt"/"en") vai até o systemPrompt do
   * agente (Fase 4 (Voz), parte 2, ajuste 4) — o TEXTO da resposta sai
   * nesse idioma, não só a voz que lê ele depois. Devolve
   * `{ ok: true, text, tools }` (tools: lista de `{toolName, risk}`
   * usadas nesse turno, pro selo discreto) ou `{ ok: false, error }` —
   * nunca lança, pra o renderer não precisar de try/catch.
   */
  ask: (prompt, outputLanguage) => ipcRenderer.invoke("sarah:ask", prompt, outputLanguage),
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
   * Widget de status (Fase 4 parte 2, etapa 2, ajuste 3): `weather`
   * não recebe nenhum argumento — localização vem por IP (`ipwho.is`)
   * e clima da Open-Meteo, as duas chamadas de rede rodando inteiras
   * no processo principal, nunca aqui (ver `main-process.ts` pro
   * porquê de não ser mais via `navigator.geolocation`). Devolve
   * `{ ok, tempC, weatherCode, city, country }`. `openLink` abre uma
   * URL/caminho de arquivo real que apareceu numa resposta da SARAH
   * (link clicável na área de legenda).
   */
  weather: () => ipcRenderer.invoke("sarah:weather"),
  openLink: (link) => ipcRenderer.invoke("sarah:openLink", link),
  /**
   * Interromper a fala (Fase 10) — mata o `say` em andamento
   * imediatamente. Devolve `{ok: true}` sempre (seguro chamar mesmo
   * sem fala nenhuma em andamento, vira no-op do lado do processo
   * principal).
   */
  stopSpeaking: () => ipcRenderer.invoke("sarah:stopSpeaking"),
  /**
   * Escuta contínua (Fase 10, ver @sarah/wake-word): `startContinuousListening(bargeIn)`
   * liga o microfone em segundo plano (wake-word + palmas, e VAD
   * também se `bargeIn` for `true`); `stopContinuousListening` desliga.
   * Os gatilhos chegam via `onVoiceTrigger` (evento, não invoke — pode
   * disparar a qualquer momento, sem o renderer ter pedido nada
   * naquele instante), que devolve uma função de CANCELAR a inscrição
   * (mesmo padrão de `ipcRenderer.on`/`removeListener` de sempre nesse
   * tipo de assinatura, pra não vazar listener se o renderer recarregar).
   * `onVoiceTriggerError` avisa de queda FATAL da escuta contínua (ex.:
   * processo Python morreu sozinho) — a UI precisa destravar o toggle
   * nesse caso, já que a escuta parou sem o usuário ter pedido.
   */
  startContinuousListening: (bargeIn) => ipcRenderer.invoke("sarah:startContinuousListening", bargeIn),
  stopContinuousListening: () => ipcRenderer.invoke("sarah:stopContinuousListening"),
  onVoiceTrigger: (callback) => {
    const listener = (_event, voiceEvent) => callback(voiceEvent);
    ipcRenderer.on("sarah:voiceTrigger", listener);
    return () => ipcRenderer.removeListener("sarah:voiceTrigger", listener);
  },
  onVoiceTriggerError: (callback) => {
    const listener = (_event, message) => callback(message);
    ipcRenderer.on("sarah:voiceTriggerError", listener);
    return () => ipcRenderer.removeListener("sarah:voiceTriggerError", listener);
  },
});
