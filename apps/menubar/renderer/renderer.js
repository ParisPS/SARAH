// Sem framework nenhum de propósito — janela pequena, não justifica
// React/Vue. `window.sarah.*` vem do preload.cjs (contextBridge) —
// este arquivo não tem acesso a Node/Electron diretamente
// (contextIsolation: true).
import { createHologram } from "./hologram.js";
import { refreshDashboard } from "./dashboard.js";

const conversation = document.getElementById("conversation");
const input = document.getElementById("promptInput");
const coreTaskEl = document.getElementById("core-task");

/**
 * Glifos 2D (SVG inline, monocromático — mesma paleta azul/branca do
 * holograma) mostrados centralizados sobre o NÚCLEO da esfera durante
 * a animação de cada categoria de tarefa (Fase 4 parte 4, corrigido:
 * a animação NÃO é um ícone junto do selo de texto da mensagem — é o
 * núcleo central que "se transforma" brevemente, ver `hologram.js`).
 * `"memory"` de propósito NÃO tem entrada aqui: a reação de
 * `memory.remember` é só o próprio núcleo brilhando/crescendo (já
 * feito dentro de `hologram.js`), sem glifo por cima.
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
 * Metadado por PREFIXO de tool (`mcp__<server>__<tool>`) pro selo
 * discreto sob cada resposta (item 2 da Fase 4 parte 3): emoji + nome
 * amigável da integração — o selo continua sendo só texto/registro,
 * sem animação própria (a animação por categoria mudou de lugar, ver
 * `sphereTask` abaixo e o comentário de `TASK_GLYPHS`). `sphereTask`
 * é a categoria enfileirada em `hologram.playTask()` quando essa tool
 * aparece na resposta — `null` quando a tool não tem uma reação
 * própria no núcleo (a maioria: leituras, rascunhos de e-mail etc.).
 * Entradas mais específicas (uma tool exata, como `create_event`) e
 * mais genéricas (o server inteiro) convivem na mesma lista —
 * `metaForTool` escolhe o prefixo mais LONGO que bate, então a
 * específica sempre vence sem precisar de ordem especial.
 */
const TOOL_META = [
  { prefix: "mcp__sarah-fixtures__", emoji: "🧪", name: "Fixture", sphereTask: null },
  { prefix: "mcp__sarah-apple-calendar__", emoji: "📅", name: "Apple Calendar", sphereTask: null },
  { prefix: "mcp__sarah-apple-calendar__create_event", emoji: "📅", name: "Apple Calendar", sphereTask: "calendar-stamp" },
  { prefix: "mcp__sarah-notion__", emoji: "🗓️", name: "Notion", sphereTask: null },
  { prefix: "mcp__sarah-notion__create_event", emoji: "🗓️", name: "Notion", sphereTask: "calendar-stamp" },
  { prefix: "mcp__sarah-apple-reminders__", emoji: "✅", name: "Reminders", sphereTask: null },
  { prefix: "mcp__sarah-apple-reminders__create_reminder", emoji: "✅", name: "Reminders", sphereTask: "writing" },
  { prefix: "mcp__sarah-gmail__", emoji: "✉️", name: "Gmail", sphereTask: null },
  { prefix: "mcp__sarah-gmail__send_draft", emoji: "✉️", name: "Gmail", sphereTask: "gmail-send" },
  { prefix: "mcp__sarah-memory__", emoji: "🧠", name: "Memória", sphereTask: null },
  { prefix: "mcp__sarah-memory__remember", emoji: "🧠", name: "Memória", sphereTask: "memory" },
  { prefix: "mcp__sarah-apple-notes__", emoji: "📝", name: "Apple Notes", sphereTask: null },
  { prefix: "mcp__sarah-apple-notes__create_note", emoji: "📝", name: "Apple Notes", sphereTask: "writing" },
];

function metaForTool(toolName) {
  let best = null;
  for (const meta of TOOL_META) {
    if (toolName.startsWith(meta.prefix) && (!best || meta.prefix.length > best.prefix.length)) {
      best = meta;
    }
  }
  return best ?? { emoji: "", name: toolName, sphereTask: null };
}

function addMessage(who, text, tools) {
  const row = document.createElement("div");
  row.className = `row ${who}`;

  const bubble = document.createElement("div");
  bubble.className = "bubble";

  const textEl = document.createElement("div");
  textEl.className = "text";
  // textContent, não innerHTML: texto do usuário e resposta do modelo
  // nunca devem ser interpretados como HTML.
  textEl.textContent = text;
  bubble.appendChild(textEl);

  if (tools && tools.length > 0) {
    const toolsEl = document.createElement("div");
    toolsEl.className = "tools";
    for (const tool of tools) {
      const meta = metaForTool(tool.toolName);
      const chip = document.createElement("span");
      chip.className = `chip ${tool.risk === "high" ? "high" : ""}`;

      const icon = document.createElement("span");
      icon.className = "chip-icon";
      icon.textContent = meta.emoji;
      chip.appendChild(icon);

      const label = document.createElement("span");
      label.className = "chip-label";
      label.textContent = `${meta.name} · ${tool.risk === "high" ? "alto risco" : "baixo risco"}`;
      chip.appendChild(label);

      toolsEl.appendChild(chip);
    }
    bubble.appendChild(toolsEl);

    // A animação da tarefa acontece no NÚCLEO CENTRAL da esfera, NÃO
    // aqui no selo (o selo continua só texto/registro, como sempre) —
    // enfileira uma animação por tool com reação própria, na ordem em
    // que rodaram; `hologram.js` garante que tocam uma de cada vez,
    // nunca sobrepostas, mesmo se mais de uma tool relevante rodou
    // nesta mesma resposta.
    for (const tool of tools) {
      const sphereTask = metaForTool(tool.toolName).sphereTask;
      if (sphereTask) hologram.playTask(sphereTask);
    }
  }

  row.appendChild(bubble);
  conversation.appendChild(row);
  conversation.scrollTop = conversation.scrollHeight;
}

async function handleSubmit() {
  const prompt = input.value.trim();
  if (!prompt) return;

  input.value = "";
  input.disabled = true;
  addMessage("user", prompt);
  // A visualização holográfica SUBSTITUI qualquer indicador de texto
  // tipo "digitando..." — fica mais ativa enquanto aguarda o stream
  // responder, volta a ficar ociosa no `finally`.
  hologram.setState("thinking");

  try {
    const result = await window.sarah.ask(prompt);
    if (result.ok) {
      addMessage("sarah", result.text || "(sem resposta em texto)", result.tools);
    } else {
      addMessage("erro", result.error);
    }
  } catch (err) {
    addMessage("erro", err && err.message ? err.message : String(err));
  } finally {
    hologram.setState("idle");
    input.disabled = false;
    input.focus();
    // Números do dashboard (proporção de risco, atividade por
    // categoria/hora) podem ter mudado com o que acabou de rodar —
    // atualiza os painéis sem precisar fechar/reabrir a janela.
    refreshDashboard();
  }
}

input.addEventListener("keydown", (event) => {
  if (event.key === "Enter") handleSubmit();
});
