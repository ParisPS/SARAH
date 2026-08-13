// Widget de status (Fase 4 parte 2, etapa 2) — data/hora sempre
// disponíveis (não dependem de rede nem permissão nenhuma); clima e
// localização vêm de `window.sarah.weather()` (main-process.ts), que
// resolve os dois num único IPC — nem coordenadas nem permissão
// nenhuma são pedidas por aqui.
//
// Ajuste 3, achado real: a primeira versão pedia a localização via
// `navigator.geolocation` (Core Location do sistema, através do
// Chromium) — a permissão do macOS era concedida sem problema, mas a
// chamada em si falhava sempre com `GeolocationPositionError: Timeout
// expired`, mesmo aumentando o timeout de 10s pra 25s. Investigado
// (não só "tentado de nov"): é um bug antigo e conhecido do Electron
// (github.com/electron/electron/issues/28443, entre outras) — o
// provedor de localização por rede do Chromium exige uma
// `GOOGLE_API_KEY` paga do Google Cloud pra funcionar de verdade, sem
// ela falha nesse mesmo erro mesmo com a permissão do sistema
// concedida. Decisão explícita do usuário (não escolhida sozinha):
// trocar pra localização por IP no processo principal, sem chave paga
// nem popup de permissão — ver `main-process.ts`, handler
// `sarah:weather`.

const timeEl = document.getElementById("status-time");
const dateEl = document.getElementById("status-date");
const weatherEl = document.getElementById("status-weather");
const locationEl = document.getElementById("status-location");

// Descrições curtas pros códigos WMO que a Open-Meteo devolve —
// cobre só as faixas mais comuns (não precisa de tradução completa da
// tabela WMO inteira pra um widget discreto de canto de tela).
const WEATHER_DESCRIPTIONS = {
  0: "céu limpo",
  1: "poucas nuvens",
  2: "parc. nublado",
  3: "nublado",
  45: "neblina",
  48: "neblina",
  51: "garoa",
  53: "garoa",
  55: "garoa",
  61: "chuva fraca",
  63: "chuva",
  65: "chuva forte",
  71: "neve fraca",
  73: "neve",
  75: "neve forte",
  80: "pancadas",
  81: "pancadas",
  82: "pancadas fortes",
  95: "tempestade",
  96: "tempestade",
  99: "tempestade",
};

function updateClock() {
  const now = new Date();
  timeEl.textContent = now.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  dateEl.textContent = now.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
}

/** Chamado uma vez, no carregamento da janela principal. */
export async function initStatusWidget() {
  updateClock();
  setInterval(updateClock, 15_000);

  try {
    const result = await window.sarah.weather();
    if (!result.ok) {
      console.error(`[status-widget] sarah:weather falhou: ${result.error}`);
      locationEl.textContent = "clima indisponível";
      return;
    }
    if (typeof result.tempC === "number") {
      const description = WEATHER_DESCRIPTIONS[result.weatherCode] ?? "";
      weatherEl.textContent = `${Math.round(result.tempC)}°C${description ? " · " + description : ""}`;
    }
    locationEl.textContent = [result.city, result.country].filter(Boolean).join(", ") || "localização desconhecida";
  } catch (err) {
    console.error(`[status-widget] erro buscando clima/localização: ${err instanceof Error ? err.message : String(err)}`);
    locationEl.textContent = "clima indisponível";
  }
}
