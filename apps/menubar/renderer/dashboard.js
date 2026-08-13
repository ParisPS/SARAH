// Painéis do dashboard (Fase 4 parte 3.5) — TODO dado aqui vem de
// `window.sarah.dashboard()` (ver preload.cjs → sarah-daemon.ts →
// daemon.ts → `SarahSession.dashboard()` em @sarah/core), que por sua
// vez só expõe: presença real de configuração por integração (nunca
// uma "confiança" inventada) e três agregações reais do audit log
// (`@sarah/audit`). Nenhum painel decorativo — se não tem fonte real,
// não existe aqui.
//
// Fase 4 parte 2, etapa 2, ajuste 2: os emojis ao lado de cada nome
// (integrações e categorias) saíram — pedido explícito comparando com
// o mockup de referência, que usa só texto + indicador de cor. O mapa
// `ICONS` que existia aqui foi removido (não sobrou nenhum uso).

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderIntegrations(container, integrations) {
  container.innerHTML = "";
  if (!integrations || integrations.length === 0) {
    container.appendChild(el("div", "empty-panel", "sem dado disponível"));
    return;
  }
  for (const integ of integrations) {
    const row = el("div", "integration-row");
    row.appendChild(el("span", `dot ${integ.configured ? "ok" : "off"}`));
    row.appendChild(el("span", "name", integ.label));
    row.appendChild(el("span", "detail", integ.configured ? "" : "não configurada"));
    row.title = integ.detail;
    container.appendChild(row);
  }
}

/**
 * Donut de verdade (Fase 4 parte 2, etapa 2, ajuste 2 — antes era uma
 * barra horizontal) — dois arcos via `stroke-dasharray` em duas
 * `<circle>` concêntricas, sem biblioteca de gráfico nova. Cada arco é
 * ENCURTADO por `gap` unidades (raio do círculo em unidades de
 * viewBox, não pixels) pra abrir um respiro visível entre os dois
 * segmentos — só quando os dois existem de verdade (100%/0% não tem
 * gap nenhum, senão o círculo inteiro ficaria com uma mordida sem
 * sentido). `stroke-linecap: round` (CSS) arredonda as pontas de cada
 * arco, mesmo efeito do mockup de referência.
 */
function buildRiskDonut(lowPct, highPct) {
  const size = 100;
  const r = 40;
  const strokeWidth = 11;
  const circumference = 2 * Math.PI * r;
  const hasBothSegments = lowPct > 0 && highPct > 0;
  const gap = hasBothSegments ? 5 : 0;

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("id", "risk-donut");
  svg.setAttribute("viewBox", `0 0 ${size} ${size}`);

  // Gira o grupo inteiro pra o primeiro arco começar às 12h (padrão
  // visual de gráfico de pizza/donut) em vez de às 3h, que é onde um
  // `<circle>` sem rotação começa a desenhar o traço por padrão.
  const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
  group.setAttribute("transform", `rotate(-90 ${size / 2} ${size / 2})`);

  function segment(pct, offset, color) {
    const raw = (pct / 100) * circumference;
    const length = Math.max(0, raw - gap);
    const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    circle.setAttribute("cx", String(size / 2));
    circle.setAttribute("cy", String(size / 2));
    circle.setAttribute("r", String(r));
    circle.setAttribute("fill", "none");
    circle.setAttribute("stroke", color);
    circle.setAttribute("stroke-width", String(strokeWidth));
    circle.setAttribute("stroke-linecap", "round");
    circle.setAttribute("stroke-dasharray", `${length} ${circumference - length}`);
    circle.setAttribute("stroke-dashoffset", String(-offset));
    return circle;
  }

  if (lowPct > 0) group.appendChild(segment(lowPct, 0, "var(--accent-bright)"));
  if (highPct > 0) group.appendChild(segment(highPct, (lowPct / 100) * circumference, "var(--risk-high)"));
  svg.appendChild(group);
  return svg;
}

function renderRisk(container, riskCounts) {
  container.innerHTML = "";
  const total = riskCounts.low + riskCounts.high;
  if (total === 0) {
    container.appendChild(el("div", "empty-panel", "nenhuma ação registrada ainda"));
    return;
  }
  const lowPct = (riskCounts.low / total) * 100;
  const highPct = 100 - lowPct;

  const wrap = el("div", "risk-donut-wrap");
  wrap.appendChild(buildRiskDonut(lowPct, highPct));

  const center = el("div", "risk-donut-center");
  center.appendChild(el("div", "risk-donut-pct", `${Math.round(lowPct)}%`));
  center.appendChild(el("div", "risk-donut-label", "baixo risco"));
  wrap.appendChild(center);

  const legend = el("div", "risk-legend");
  const lowLabel = el("span");
  lowLabel.innerHTML = `<span class="swatch low"></span>baixo · ${riskCounts.low}`;
  const highLabel = el("span");
  highLabel.innerHTML = `<span class="swatch high"></span>alto · ${riskCounts.high}`;
  legend.append(lowLabel, highLabel);

  container.append(wrap, legend);
}

function renderCategories(container, categoryCounts) {
  container.innerHTML = "";
  if (!categoryCounts || categoryCounts.length === 0) {
    container.appendChild(el("div", "empty-panel", "nenhuma ação registrada ainda"));
    return;
  }
  const max = Math.max(...categoryCounts.map((c) => c.count));
  for (const cat of categoryCounts) {
    const row = el("div", "category-row");
    row.appendChild(el("span", "label", cat.server.replace("sarah-", "")));
    const track = el("div", "track");
    const fill = el("div", "fill");
    fill.style.width = `${(cat.count / max) * 100}%`;
    track.appendChild(fill);
    row.appendChild(track);
    row.appendChild(el("span", "count", String(cat.count)));
    container.appendChild(row);
  }
}

function renderActivity(container, hourlyActivity) {
  container.innerHTML = "";
  if (!hourlyActivity || hourlyActivity.length === 0) {
    container.appendChild(el("div", "empty-panel", "sem dado disponível"));
    return;
  }
  const max = Math.max(1, ...hourlyActivity.map((h) => h.count));
  const width = 260;
  const height = 46;
  const barGap = 1.5;
  const barWidth = width / hourlyActivity.length - barGap;

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("id", "activity-chart");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("width", "100%");
  svg.setAttribute("height", height);
  svg.setAttribute("preserveAspectRatio", "none");

  hourlyActivity.forEach((bucket, i) => {
    // Fase 4 parte 4 — achado revalidando o item 3 do pedido: os dados
    // já vinham zero-preenchidos (`hourlyBuckets`, @sarah/audit) desde
    // a parte 3.5, mas a barra "zero" tinha 1px de altura numa cor
    // quase idêntica ao fundo do painel — na prática, ilegível/invisível,
    // dando a impressão de "buraco" no gráfico mesmo com a coluna
    // presente. Corrigido com altura mínima maior (3px) e uma cor
    // claramente mais clara que o fundo, pra cada uma das 24 colunas
    // ficar sempre visível como "uma barra baixa", nunca como um vazio.
    const barHeight = bucket.count === 0 ? 3 : Math.max(3, (bucket.count / max) * (height - 4));
    const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    rect.setAttribute("x", String(i * (barWidth + barGap)));
    rect.setAttribute("y", String(height - barHeight));
    rect.setAttribute("width", String(Math.max(1, barWidth)));
    rect.setAttribute("height", String(barHeight));
    rect.setAttribute("rx", "0.75");
    rect.setAttribute("fill", bucket.count === 0 ? "#26385c" : "#5fa8f5");
    const hour = new Date(bucket.hourStart);
    const label = document.createElementNS("http://www.w3.org/2000/svg", "title");
    label.textContent = `${hour.toLocaleString("pt-BR", { hour: "2-digit", day: "2-digit", month: "2-digit" })}h — ${bucket.count} ação(ões)`;
    rect.appendChild(label);
    svg.appendChild(rect);
  });

  container.appendChild(svg);
}

/**
 * Busca e renderiza os quatro painéis de uma vez. Chamado no carregamento
 * da janela e de novo depois de cada resposta da SARAH (pra números
 * mudarem de acordo com uso real, sem precisar fechar/reabrir).
 */
export async function refreshDashboard() {
  const data = await window.sarah.dashboard();
  if (!data) return;
  renderIntegrations(document.querySelector("#panel-integrations .body"), data.integrations);
  renderRisk(document.querySelector("#panel-risk .body"), data.riskCounts);
  renderCategories(document.querySelector("#panel-categories .body"), data.categoryCounts);
  renderActivity(document.querySelector("#panel-activity .body"), data.hourlyActivity);
}
