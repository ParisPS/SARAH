// Sem framework nenhum de propósito — janela pequena, não justifica
// React/Vue. `window.sarah.*` vem do preload.cjs (contextBridge) —
// este arquivo não tem acesso a Node/Electron diretamente
// (contextIsolation: true).
import { createHologram } from "./hologram.js";
import { refreshDashboard } from "./dashboard.js";
import { metaForTool } from "./tool-meta.js";
import { initStatusWidget } from "./status-widget.js";

const input = document.getElementById("promptInput");
const micBtn = document.getElementById("micBtn");
const textToggleBtn = document.getElementById("textToggleBtn");
const langButtons = Array.from(document.querySelectorAll(".lang-btn"));
const coreTaskEl = document.getElementById("core-task");
const stageContent = document.getElementById("stage-content");
const STAGE_HINT = stageContent.textContent.trim();

initStatusWidget();

/**
 * Glifos 2D (SVG inline, monocromático — mesma paleta azul/branca do
 * holograma) mostrados centralizados sobre o NÚCLEO da esfera durante
 * a animação de cada categoria de tarefa (Fase 4 parte 4) — inalterado
 * pela Fase 4 parte 2 (voz), só migrou pra este arquivo continuar
 * funcionando sem a lista de mensagens que existia antes.
 */
const TASK_GLYPHS = {
  "gmail-send": `<svg viewBox="0 0 48 48" width="40" height="40" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <rect x="6" y="12" width="36" height="24" rx="2"></rect>
    <path d="M7 13l17 14 17-14"></path>
  </svg>`,
  "calendar-stamp": `<svg viewBox="0 0 48 48" width="40" height="40" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <rect x="8" y="10" width="32" height="30" rx="3"></rect>
    <path d="M8 18h32"></path>
    <path d="M16 6v8M32 6v8"></path>
    <path class="core-task-check" d="M16 27l6 6 11-13"></path>
  </svg>`,
  writing: `<svg viewBox="0 0 48 48" width="40" height="40" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path class="core-task-pen" d="M10 34l4-1 17-17a2.2 2.2 0 000-3.1l-1-1a2.2 2.2 0 00-3.1 0L10 29.9z"></path>
    <line class="core-task-stroke-line" x1="8" y1="40" x2="30" y2="40"></line>
  </svg>`,
};

const hologram = createHologram(document.getElementById("hologram"), {
  onTaskStart(category) {
    const markup = TASK_GLYPHS[category];
    if (!markup) return; // "memory" (e categorias desconhecidas): núcleo reage sozinho, sem overlay 2D
    coreTaskEl.className = ""; // limpa a classe anterior — garante reinício mesmo se a MESMA categoria tocar de novo em seguida
    coreTaskEl.innerHTML = markup;
    void coreTaskEl.offsetWidth; // força reflow antes de reaplicar a classe que dispara a animação CSS
    coreTaskEl.classList.add(`core-task-${category}`);
  },
  onTaskEnd() {
    coreTaskEl.className = "";
    coreTaskEl.innerHTML = "";
  },
});

refreshDashboard();

/**
 * Idioma de SAÍDA (voz da SARAH) — Fase 4 parte 2. Independente do
 * idioma que o usuário fala/digita PRA ela, que é sempre
 * auto-detectado pelo STT (ver @sarah/voice) — os dois nunca precisam
 * bater. "pt" por padrão.
 */
let outputLanguage = "pt";
for (const btn of langButtons) {
  btn.addEventListener("click", () => {
    outputLanguage = btn.dataset.lang;
    for (const b of langButtons) b.classList.toggle("active", b === btn);
  });
}

/**
 * Área de legenda (Fase 4 parte 2, etapa 2) — deixou de ser um espaço
 * vazio de respiro e virou o lugar onde a última resposta aparece,
 * com um link clicável quando o texto contém uma URL ou um caminho de
 * arquivo absoluto real (ex.: SVG exportado, apresentação gerada,
 * link do Figma). Duas regras simples, de propósito — não tenta
 * parsear markdown nem HTML, só reconhece o padrão mais comum de cada
 * caso: `http(s)://...` pra URL, e `/Users/...`, `/tmp/...`, `/var/...`
 * ou `~/...` pra caminho (evita falso-positivo em texto comum tipo
 * "e/ou"). O conjunto excluído inclui crase e asterisco — achado real
 * testando: a resposta da SARAH costuma envolver caminhos em markdown
 * (`` `/Users/.../arquivo.svg` ``), e sem excluir a crase ela entrava
 * no match e virava parte do "caminho", quebrando `shell.openPath`
 * silenciosamente (arquivo com um caractere a mais no fim não existe).
 */
const URL_PATTERN = /https?:\/\/[^\s<>()"'`*]+/;
const PATH_PATTERN = /(~\/[^\s<>()"'`*]+|\/(?:Users|tmp|var)\/[^\s<>()"'`*]+)/;

function extractLink(text) {
  const urlMatch = text.match(URL_PATTERN);
  if (urlMatch) return urlMatch[0].replace(/[.,;:)]+$/, "");
  const pathMatch = text.match(PATH_PATTERN);
  if (pathMatch) return pathMatch[0].replace(/[.,;:)]+$/, "");
  return null;
}

function shortenLink(link) {
  if (link.length <= 46) return link;
  return `${link.slice(0, 22)}…${link.slice(-20)}`;
}

/** Estado passageiro ("🎙 ouvindo...", "💭 pensando...") — some assim que vira uma resposta de verdade. */
function showStageStatus(text) {
  stageContent.className = "status";
  stageContent.textContent = text;
}

/** Volta pro texto de dica original — usado quando um status passageiro termina sem virar resposta (ex.: gravação sem fala nenhuma). */
function showStageHint() {
  stageContent.className = "hint";
  stageContent.textContent = STAGE_HINT;
}

/** Última resposta da SARAH — fica visível até a próxima (não é um toast que some sozinho). */
function showStageResponse(text) {
  stageContent.className = "response";
  stageContent.innerHTML = "";

  const textEl = document.createElement("div");
  textEl.className = "response-text";
  textEl.textContent = text;
  stageContent.appendChild(textEl);

  const link = extractLink(text);
  if (link) {
    const chip = document.createElement("button");
    chip.className = "link-chip";
    chip.textContent = `🔗 ${shortenLink(link)}`;
    chip.title = link;
    chip.addEventListener("click", async () => {
      const result = await window.sarah.openLink(link);
      // Falha aqui não é silenciosa mais (achado real: um `\`` colado
      // no fim do caminho, extraído da resposta em markdown, fazia
      // `shell.openPath` falhar sem nada visível na tela) — o próprio
      // chip vira a mensagem de erro por alguns segundos, depois volta.
      if (!result.ok) {
        const original = chip.textContent;
        chip.textContent = `⚠️ não abriu: ${result.error}`;
        setTimeout(() => {
          chip.textContent = original;
        }, 4000);
      }
    });
    stageContent.appendChild(chip);
  }
}

let busy = false; // true durante ask()+speak() — não durante a gravação em si (o próprio botão precisa continuar clicável pra parar)
let recording = false;

function updateControlsDisabled() {
  input.disabled = busy || recording;
  textToggleBtn.disabled = busy || recording;
  micBtn.disabled = busy;
}

/**
 * Fluxo compartilhado por texto digitado E fala transcrita — Fase 4
 * parte 2, comportamento confirmado com o usuário: "toda resposta é
 * falada em voz alta, sempre, mesmo quando o pedido veio digitado".
 * A lista de mensagens não existe mais nesta janela (ver `#stage` em
 * index.html) — a conversa completa fica só no painel de histórico
 * (`sarah:ask`, no processo principal, já grava lá; ver
 * `main-process.ts`). Aqui só cuida do holograma e da fala.
 */
async function sendPrompt(prompt) {
  if (!prompt) return;
  busy = true;
  updateControlsDisabled();
  hologram.setState("thinking");
  showStageStatus("💭 pensando...");

  try {
    const result = await window.sarah.ask(prompt);
    const responseText = result.ok ? result.text || "" : result.error;

    if (result.ok && result.tools) {
      for (const tool of result.tools) {
        const sphereTask = metaForTool(tool.toolName).sphereTask;
        if (sphereTask) hologram.playTask(sphereTask);
      }
    }

    hologram.setState("idle");

    if (responseText) {
      showStageResponse(responseText);
      await window.sarah.speak(responseText, outputLanguage);
    } else {
      showStageHint();
    }
  } finally {
    busy = false;
    updateControlsDisabled();
    input.focus();
    // Números do dashboard (proporção de risco, atividade por
    // categoria/hora) podem ter mudado com o que acabou de rodar —
    // atualiza os painéis sem precisar fechar/reabrir a janela.
    refreshDashboard();
  }
}

// --- entrada de texto, minimizável (Fase 4 parte 2) -----------------
// O campo só aparece quando o ícone de teclado é clicado — "não em
// destaque por padrão", pedido explícito. Colapsa de novo depois de
// enviar (Enter) ou cancelar (Esc/perder foco vazio).
textToggleBtn.addEventListener("click", () => {
  const expanded = input.classList.toggle("expanded");
  if (expanded) {
    input.focus();
  } else {
    input.value = "";
  }
});

input.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    const prompt = input.value.trim();
    input.value = "";
    input.classList.remove("expanded");
    sendPrompt(prompt);
  } else if (event.key === "Escape") {
    input.value = "";
    input.classList.remove("expanded");
  }
});

input.addEventListener("blur", () => {
  if (!input.value) input.classList.remove("expanded");
});

// --- microfone (Fase 4 parte 2) --------------------------------------
// Clique 1: começa a gravar (esfera vira "listening", botão pulsa em
// vermelho). Termina sozinho depois de silêncio detectado (ver
// @sarah/voice) OU no clique 2 (parar manualmente) — os dois casos
// resolvem a MESMA `awaitRecording()`, então o fluxo abaixo não
// precisa saber qual dos dois aconteceu.
micBtn.addEventListener("click", async () => {
  if (!recording) {
    recording = true;
    micBtn.classList.add("recording");
    micBtn.title = "Parar gravação";
    updateControlsDisabled();
    hologram.setState("listening");
    showStageStatus("🎙 ouvindo...");

    const started = await window.sarah.startRecording();
    if (!started.ok) {
      recording = false;
      micBtn.classList.remove("recording");
      micBtn.title = "Falar";
      updateControlsDisabled();
      hologram.setState("idle");
      showStageHint();
      return;
    }

    const result = await window.sarah.awaitRecording();
    recording = false;
    micBtn.classList.remove("recording");
    micBtn.title = "Falar";
    updateControlsDisabled();

    if (result.ok && result.text && result.text.trim()) {
      await sendPrompt(result.text.trim());
    } else {
      hologram.setState("idle");
      showStageHint();
    }
  } else {
    // Parar manualmente — `awaitRecording()` já pendurado acima
    // resolve sozinho assim que o processo principal detectar o fim
    // da gravação, não precisa esperar nada aqui.
    window.sarah.stopRecording();
  }
});
