// Sem framework nenhum de propósito — janela pequena, não justifica
// React/Vue. `window.sarah.*` vem do preload.cjs (contextBridge) —
// este arquivo não tem acesso a Node/Electron diretamente
// (contextIsolation: true).
import { createHologram } from "./hologram.js";
import { refreshDashboard } from "./dashboard.js";

const conversation = document.getElementById("conversation");
const input = document.getElementById("promptInput");
const hologram = createHologram(document.getElementById("hologram"));

refreshDashboard();

/**
 * Rótulo amigável por PREFIXO de tool (`mcp__<server>__<tool>`) — só
 * precisa do server, não da tool exata, pro selo discreto de "qual
 * integração rodou" (item 2 da Fase 4 parte 3). Cai no nome cru se
 * algum server novo aparecer sem entrada aqui (nunca quebra, só
 * mostra menos bonito).
 */
const TOOL_LABELS = [
  ["mcp__sarah-fixtures__", "🧪 Fixture"],
  ["mcp__sarah-apple-calendar__", "📅 Apple Calendar"],
  ["mcp__sarah-notion__", "🗓️ Notion"],
  ["mcp__sarah-apple-reminders__", "✅ Reminders"],
  ["mcp__sarah-gmail__", "✉️ Gmail"],
  ["mcp__sarah-memory__", "🧠 Memória"],
  ["mcp__sarah-apple-notes__", "📝 Notes"],
];

function labelForTool(toolName) {
  const match = TOOL_LABELS.find(([prefix]) => toolName.startsWith(prefix));
  return match ? match[1] : toolName;
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
      const chip = document.createElement("span");
      chip.className = `chip ${tool.risk === "high" ? "high" : ""}`;
      chip.textContent = `${labelForTool(tool.toolName)} · ${tool.risk === "high" ? "alto risco" : "baixo risco"}`;
      toolsEl.appendChild(chip);
    }
    bubble.appendChild(toolsEl);
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
