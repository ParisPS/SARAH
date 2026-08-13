// Widget de status (Fase 4 parte 2, etapa 2) — data/hora sempre
// disponíveis (não dependem de rede nem permissão nenhuma); clima e
// localização só aparecem depois que `navigator.geolocation` (API do
// PRÓPRIO Chromium, não um fetch — no macOS usa o Core Location do
// sistema por baixo, mesma categoria de permissão do Painel de
// Privacidade já usada por Calendar/Reminders/Notes) devolver
// coordenadas, que então vão pro processo principal
// (`window.sarah.weather`, ver preload.cjs/main-process.ts) buscar de
// verdade na Open-Meteo (clima) + BigDataCloud (cidade/país). Se o
// usuário negar a permissão, ou a API não existir, o widget continua
// mostrando data/hora normalmente — só o clima/local ficam com uma
// mensagem curta, nunca quebra o resto da tela.

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
export function initStatusWidget() {
  updateClock();
  setInterval(updateClock, 15_000);

  if (!navigator.geolocation) {
    locationEl.textContent = "localização indisponível";
    return;
  }

  navigator.geolocation.getCurrentPosition(
    async (position) => {
      const { latitude, longitude } = position.coords;
      try {
        const result = await window.sarah.weather(latitude, longitude);
        if (!result.ok) {
          locationEl.textContent = "clima indisponível";
          return;
        }
        if (typeof result.tempC === "number") {
          const description = WEATHER_DESCRIPTIONS[result.weatherCode] ?? "";
          weatherEl.textContent = `${Math.round(result.tempC)}°C${description ? " · " + description : ""}`;
        }
        locationEl.textContent = [result.city, result.country].filter(Boolean).join(", ") || "localização desconhecida";
      } catch {
        locationEl.textContent = "clima indisponível";
      }
    },
    (error) => {
      // `PERMISSION_DENIED` (código 1) é o caso mais comum — usuário
      // negou o popup de Localização do macOS. Os outros dois códigos
      // (`POSITION_UNAVAILABLE`, `TIMEOUT`) são infraestrutura, não
      // permissão, mas a mensagem só precisa deixar claro que o dado
      // não veio, não precisa diferenciar todos os casos pro usuário.
      locationEl.textContent = error.code === error.PERMISSION_DENIED ? "localização não autorizada" : "localização indisponível";
    },
    { timeout: 10_000, maximumAge: 10 * 60 * 1000 }
  );
}
