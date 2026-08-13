// Painel de histórico (item 3 da Fase 4 parte 3, ganhou a CONVERSA na
// Fase 4 parte 2 — voz: a janela principal não lista mais mensagens
// por padrão, ver `index.html`/`renderer.js` — a conversa completa
// migrou pra cá) — janela separada, aberta pelo menu de contexto do
// ícone (botão direito → "Histórico"). Os dois conjuntos de dado vêm
// do mesmo daemon, sem duplicar nada: `window.sarah.conversationHistory()`
// (prompt/resposta de cada turno, gravado em memória no processo
// principal — ver `main-process.ts`) e `window.sarah.history()` (as
// decisões do Gateway, como já era).
import { metaForTool } from "./tool-meta.js";

const conversationEl = document.getElementById("conversation");
const content = document.getElementById("content");

function decisionLabel(decision) {
  if (decision === "auto-allow") return "auto-permitido";
  if (decision === "confirmed") return "confirmado";
  if (decision === "denied") return "negado";
  return decision;
}

function renderConversation(entries) {
  if (!entries || entries.length === 0) {
    conversationEl.innerHTML = '<div id="empty">Nenhuma mensagem nesta sessão ainda.</div>';
    return;
  }

  conversationEl.innerHTML = "";
  for (const entry of entries) {
    const row = document.createElement("div");
    row.className = `row ${entry.who}`;

    const bubble = document.createElement("div");
    bubble.className = "bubble";

    const textEl = document.createElement("div");
    textEl.className = "text";
    textEl.textContent = entry.text;
    bubble.appendChild(textEl);

    if (entry.tools && entry.tools.length > 0) {
      const toolsEl = document.createElement("div");
      toolsEl.className = "tools";
      for (const tool of entry.tools) {
        const meta = metaForTool(tool.toolName);
        const chip = document.createElement("span");
        chip.className = `chip ${tool.risk === "high" ? "high" : ""}`;
        chip.textContent = `${meta.emoji} ${meta.name} · ${tool.risk === "high" ? "alto risco" : "baixo risco"}`;
        toolsEl.appendChild(chip);
      }
      bubble.appendChild(toolsEl);
    }

    row.appendChild(bubble);
    conversationEl.appendChild(row);
  }
  conversationEl.scrollTop = conversationEl.scrollHeight;
}

function renderGateway(entries) {
  if (!entries || entries.length === 0) {
    content.innerHTML = '<div id="empty">Nenhuma ação registrada ainda.</div>';
    return;
  }

  const table = document.createElement("table");
  table.innerHTML =
    "<thead><tr><th>Quando</th><th>Tool</th><th>Risco</th><th>Decisão</th></tr></thead>";
  const tbody = document.createElement("tbody");

  for (const entry of entries) {
    const tr = document.createElement("tr");

    const tdTime = document.createElement("td");
    tdTime.className = "time";
    const date = new Date(entry.timestamp);
    tdTime.textContent = Number.isNaN(date.getTime()) ? entry.timestamp : date.toLocaleString("pt-BR");

    const tdTool = document.createElement("td");
    tdTool.className = "tool";
    tdTool.textContent = entry.toolName;

    const tdRisk = document.createElement("td");
    const riskBadge = document.createElement("span");
    riskBadge.className = `badge risk-${entry.risk}`;
    riskBadge.textContent = entry.risk === "high" ? "alto" : "baixo";
    tdRisk.appendChild(riskBadge);

    const tdDecision = document.createElement("td");
    const decisionBadge = document.createElement("span");
    decisionBadge.className = `badge decision-${entry.decision}`;
    decisionBadge.textContent = decisionLabel(entry.decision);
    tdDecision.appendChild(decisionBadge);

    tr.append(tdTime, tdTool, tdRisk, tdDecision);
    tbody.appendChild(tr);
  }

  table.appendChild(tbody);
  content.innerHTML = "";
  content.appendChild(table);
}

window.sarah
  .conversationHistory()
  .then(renderConversation)
  .catch((err) => {
    conversationEl.textContent = "Erro ao carregar conversa: " + (err && err.message ? err.message : String(err));
  });

window.sarah
  .history(20)
  .then(renderGateway)
  .catch((err) => {
    content.textContent = "Erro ao carregar histórico: " + (err && err.message ? err.message : String(err));
  });
