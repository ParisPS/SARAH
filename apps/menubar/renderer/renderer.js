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
// Fase 10 — escuta contínua / interromper a fala.
const stopSpeakingBtn = document.getElementById("stopSpeakingBtn");
const listenToggleBtn = document.getElementById("listenToggleBtn");
const bargeInCheckbox = document.getElementById("bargeInCheckbox");

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
 * Idioma de SAÍDA — Fase 4 parte 2, ajuste 4: controla o TEXTO da
 * resposta (via `systemPrompt`, ver `sendPrompt`/`packages/core`) E a
 * voz que lê ele (`window.sarah.speak`), sempre os dois juntos —
 * achado real: antes só a voz trocava, o texto continuava saindo no
 * idioma que o modelo escolhesse sozinho, lido com sotaque errado.
 * Independente do idioma que o usuário fala/digita PRA ela, que é
 * sempre auto-detectado pelo STT (ver @sarah/voice) — os dois nunca
 * precisam bater. "pt" por padrão.
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

/**
 * Versão da resposta que vai pro TTS (Fase 4 (Voz), parte 2, ajuste 4)
 * — bug real corrigido: mandar o texto da resposta pro `say` sem
 * tratamento nenhum fazia URLs/caminhos de arquivo serem lidos
 * CARACTERE POR CARACTERE (ex.: "h-t-t-p-s dois pontos barra
 * barra..."), sem sentido nenhum em voz alta. Etapa determinística de
 * limpeza ANTES do TTS — não depende do modelo "lembrar" de resumir
 * sozinho, mesmo princípio de sempre deste projeto (preferências/
 * idioma injetados sempre, nunca uma decisão que o modelo pode
 * esquecer). Duas versões do mesmo conteúdo a partir daqui: a que vai
 * pra TELA (`showStageResponse`, texto original, link completo e
 * clicável) e a que vai pro `say` (esta função, resumida) — nunca a
 * mesma string nos dois lugares quando há link/caminho/id técnico.
 *
 * Reusa os mesmos padrões de URL/caminho já usados pro chip clicável
 * (globais aqui, pra substituir TODAS as ocorrências, não só a
 * primeira) + um padrão extra pra qualquer outro token técnico longo
 * que sobrar (hash de commit, UUID, slug de projeto) — heurística:
 * 20+ caracteres sem espaço, contendo pelo menos um caractere que uma
 * palavra normal em português/inglês não teria (dígito, `.`, `_`,
 * `-`), pra não confundir com uma palavra grande legítima.
 */
const LONG_ID_PATTERN = /\b[a-zA-Z0-9][a-zA-Z0-9._-]{19,}\b/g;

function sanitizeForSpeech(text) {
  let speech = text
    .replace(new RegExp(URL_PATTERN.source, "g"), "o link")
    .replace(new RegExp(PATH_PATTERN.source, "g"), "o arquivo")
    .replace(LONG_ID_PATTERN, (match) => (/[0-9._-]/.test(match) ? "um identificador" : match));
  // Limpa espaços duplicados e espaço sobrando antes de pontuação,
  // que sobram depois das substituições acima.
  speech = speech.replace(/\s{2,}/g, " ").replace(/\s+([.,;:!?])/g, "$1").trim();
  return speech;
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
let speaking = false; // Fase 10: true só durante o trecho de `speak()` — controla a visibilidade do botão de parar

function updateControlsDisabled() {
  input.disabled = busy || recording;
  textToggleBtn.disabled = busy || recording;
  micBtn.disabled = busy;
}

function setSpeaking(value) {
  speaking = value;
  stopSpeakingBtn.classList.toggle("visible", value);
}

/**
 * Fluxo compartilhado por texto digitado E fala transcrita — Fase 4
 * parte 2, comportamento confirmado com o usuário: "toda resposta é
 * falada em voz alta, sempre, mesmo quando o pedido veio digitado".
 * A lista de mensagens não existe mais nesta janela (ver `#stage` em
 * index.html) — a conversa completa fica só no painel de histórico
 * (`sarah:ask`, no processo principal, já grava lá; ver
 * `main-process.ts`). Aqui só cuida do holograma e da fala.
 *
 * `outputLanguage` vai junto no `ask()` (ajuste 4) — o agente escreve
 * a resposta INTEIRA nesse idioma (ver `packages/core/src/index.ts`),
 * não é só a voz que muda depois. Antes disso, o toggle só trocava a
 * voz do `say`, deixando texto e voz em idiomas diferentes.
 */
async function sendPrompt(prompt) {
  if (!prompt) return;
  busy = true;
  updateControlsDisabled();
  hologram.setState("thinking");
  showStageStatus("💭 pensando...");

  try {
    const result = await window.sarah.ask(prompt, outputLanguage);
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
      setSpeaking(true);
      try {
        // Fase 10: `speak()` resolve tanto quando a fala termina
        // sozinha quanto quando é interrompida (`stopSpeaking()` mata
        // o processo `say`, que dispara o mesmo evento de término do
        // lado do processo principal — ver @sarah/voice) — não precisa
        // distinguir os dois casos aqui, os dois liberam a interface
        // normalmente.
        await window.sarah.speak(sanitizeForSpeech(responseText), outputLanguage);
      } finally {
        setSpeaking(false);
      }
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
//
// Fase 10: extraído pra função nomeada (era só o corpo do listener de
// clique) — a escuta contínua (wake-word "SARAH"/duas palmas, ver
// `handleVoiceTrigger` mais abaixo) precisa disparar EXATAMENTE este
// mesmo fluxo, "como se o botão tivesse sido clicado" (pedido
// explícito), não uma cópia paralela que poderia divergir com o tempo.
async function startVoiceInteraction() {
  if (recording) {
    // Já gravando (clique manual de novo, ou um gatilho repetido
    // enquanto a gravação anterior ainda não terminou) — mesmo
    // comportamento de sempre do botão: um segundo acionamento PARA a
    // gravação em vez de começar outra.
    window.sarah.stopRecording();
    return;
  }

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
}

micBtn.addEventListener("click", startVoiceInteraction);

// --- interromper a fala (Fase 10) -------------------------------------
stopSpeakingBtn.addEventListener("click", () => {
  window.sarah.stopSpeaking();
  // `setSpeaking(false)` já vai acontecer sozinho quando a Promise de
  // `speak()` resolver (ver `sendPrompt`, o `finally`) — chamado aqui
  // TAMBÉM, direto, só pra sumir com o botão na hora do clique, sem
  // esperar a viagem de IPC de ida e volta (diferença de poucos ms na
  // prática, mas feedback instantâneo importa pra um botão de "parar").
  setSpeaking(false);
});

// --- escuta contínua (Fase 10) -----------------------------------------
// Wake-word ("SARAH", ou o placeholder "hey jarvis" até o modelo
// customizado existir — ver docs/architecture.md) + duas palmas
// seguidas, via @sarah/wake-word (processo Python separado). NÃO liga
// sozinha ao abrir o app — sempre precisa ser ativada aqui, decisão
// explícita ("não obrigatória pra sempre").
let continuousListening = false;

/**
 * Barge-in (Fase 10, opcional/experimental): interrompe a fala
 * automaticamente quando a SARAH está falando E o usuário começa a
 * falar. Só age depois de `SPEECH_TICKS_TO_INTERRUPT` eventos "speech"
 * SEGUIDOS (cada um representa ~100ms de voz detectada pelo VAD do
 * lado Python, ver `listener.py`) dentro de uma janela curta — um
 * único blip não interrompe nada, precisa de voz SUSTENTADA. Isso é
 * mitigação parcial pro risco descrito no pedido original (a própria
 * voz da SARAH saindo da caixa de som e sendo captada pelo microfone
 * de volta) — NÃO é cancelamento de eco de verdade (isso exigiria um
 * algoritmo de AEC de verdade, complexidade desproporcional ao pedido
 * — "só propõe se for extensão natural sem complexidade
 * desproporcional"), é só reduzir a chance de um falso positivo curto.
 * Risco real que continua existindo, documentado em
 * docs/architecture.md: em alto-falantes (não fone de ouvido), a
 * própria fala da SARAH pode, em tese, ser sustentada o bastante pra
 * disparar isso sozinha — por isso o toggle fica DESLIGADO por padrão
 * e o usuário escolhe ligar.
 */
const SPEECH_TICKS_TO_INTERRUPT = 4;
const SPEECH_TICK_MAX_GAP_MS = 500;
let speechTickCount = 0;
let lastSpeechTickAt = 0;

function handleVoiceTrigger(event) {
  if (event.type === "wake" || event.type === "clap") {
    if (busy || recording) return; // já ocupada — mesmo guard que o clique manual já respeitava implicitamente (botão desabilitado)
    startVoiceInteraction();
    return;
  }
  if (event.type === "speech") {
    if (!speaking || !bargeInCheckbox.checked) {
      speechTickCount = 0;
      return;
    }
    const now = Date.now();
    speechTickCount = now - lastSpeechTickAt <= SPEECH_TICK_MAX_GAP_MS ? speechTickCount + 1 : 1;
    lastSpeechTickAt = now;
    if (speechTickCount >= SPEECH_TICKS_TO_INTERRUPT) {
      speechTickCount = 0;
      window.sarah.stopSpeaking();
      setSpeaking(false);
    }
  }
}

window.sarah.onVoiceTrigger(handleVoiceTrigger);
window.sarah.onVoiceTriggerError((message) => {
  console.error("[escuta contínua]", message);
  continuousListening = false;
  listenToggleBtn.classList.remove("active");
  bargeInCheckbox.disabled = true;
});

listenToggleBtn.addEventListener("click", async () => {
  if (continuousListening) {
    await window.sarah.stopContinuousListening();
    continuousListening = false;
    listenToggleBtn.classList.remove("active");
    bargeInCheckbox.disabled = true;
    return;
  }
  const result = await window.sarah.startContinuousListening(bargeInCheckbox.checked);
  if (result.ok) {
    continuousListening = true;
    listenToggleBtn.classList.add("active");
    bargeInCheckbox.disabled = false;
  } else {
    console.error("[escuta contínua]", result.error);
  }
});

// O sinalizador de barge-in só é lido no MOMENTO em que o processo
// Python é iniciado (ver `sarah:startContinuousListening`) — mudar o
// checkbox com a escuta já ativa precisa reiniciar o processo pra
// aplicar. Pequena interrupção de ~1s na escuta, aceitável (não é uma
// mudança que o usuário faria repetidamente).
bargeInCheckbox.addEventListener("change", async () => {
  if (!continuousListening) return;
  await window.sarah.stopContinuousListening();
  const result = await window.sarah.startContinuousListening(bargeInCheckbox.checked);
  if (!result.ok) {
    console.error("[escuta contínua]", result.error);
    continuousListening = false;
    listenToggleBtn.classList.remove("active");
    bargeInCheckbox.disabled = true;
  }
});
