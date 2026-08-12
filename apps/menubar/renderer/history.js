// Painel de histórico (item 3 da Fase 4 parte 3) — janela separada,
// aberta pelo menu de contexto do ícone da Tray (botão direito →
// "Histórico"). Lê as últimas decisões do Gateway direto do daemon
// (mesma fonte que `data/sarah.db`), sem duplicar nada: só chama
// `window.sarah.history()` (ver preload.cjs / sarah-daemon.ts).
const content = document.getElementById("content");

function decisionLabel(decision) {
  if (decision === "auto-allow") return "auto-permitido";
  if (decision === "confirmed") return "confirmado";
  if (decision === "denied") return "negado";
  return decision;
}

function render(entries) {
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
  .history(20)
  .then(render)
  .catch((err) => {
    content.textContent = "Erro ao carregar histórico: " + (err && err.message ? err.message : String(err));
  });
