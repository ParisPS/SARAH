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
 * barra horizontal) — um arco por `stroke-dasharray` em `<circle>`s
 * concêntricas, sem biblioteca de gráfico nova. Fase 7 parte 3: passou
 * de 2 pra até 3 segmentos (baixo/médio/alto) — recebe uma lista de
 * `{pct, color}` em vez de dois números fixos, pra não precisar
 * duplicar a lógica quando um nível novo aparecer de novo no futuro.
 * Cada arco é ENCURTADO por `gap` unidades (raio do círculo em
 * unidades de viewBox, não pixels) pra abrir um respiro visível entre
 * segmentos — só entre os que existem de verdade (>0%), senão o
 * círculo inteiro ficaria com mordidas sem sentido em segmentos
 * ausentes. `stroke-linecap: round` (CSS) arredonda as pontas de cada
 * arco, mesmo efeito do mockup de referência.
 */
function buildRiskDonut(segments) {
  const size = 100;
  const r = 40;
  const strokeWidth = 11;
  const circumference = 2 * Math.PI * r;
  const present = segments.filter((s) => s.pct > 0);
  const gap = present.length > 1 ? 5 : 0;

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

  let offset = 0;
  for (const s of present) {
    group.appendChild(segment(s.pct, offset, s.color));
    offset += (s.pct / 100) * circumference;
  }
  svg.appendChild(group);
  return svg;
}

function renderRisk(container, riskCounts) {
  container.innerHTML = "";
  const medium = riskCounts.medium ?? 0;
  const total = riskCounts.low + medium + riskCounts.high;
  if (total === 0) {
    container.appendChild(el("div", "empty-panel", "nenhuma ação registrada ainda"));
    return;
  }
  const lowPct = (riskCounts.low / total) * 100;
  const mediumPct = (medium / total) * 100;
  const highPct = (riskCounts.high / total) * 100;

  const wrap = el("div", "risk-donut-wrap");
  wrap.appendChild(
    buildRiskDonut([
      { pct: lowPct, color: "var(--accent-bright)" },
      { pct: mediumPct, color: "var(--risk-medium)" },
      { pct: highPct, color: "var(--risk-high)" },
    ])
  );

  const center = el("div", "risk-donut-center");
  center.appendChild(el("div", "risk-donut-pct", `${Math.round(lowPct)}%`));
  center.appendChild(el("div", "risk-donut-label", "baixo risco"));
  wrap.appendChild(center);

  const legend = el("div", "risk-legend");
  const lowLabel = el("span");
  lowLabel.innerHTML = `<span class="swatch low"></span>baixo · ${riskCounts.low}`;
  const mediumLabel = el("span");
  mediumLabel.innerHTML = `<span class="swatch medium"></span>médio · ${medium}`;
  const highLabel = el("span");
  highLabel.innerHTML = `<span class="swatch high"></span>alto · ${riskCounts.high}`;
  legend.append(lowLabel, mediumLabel, highLabel);

  container.append(wrap, legend);
}

// Dashboard v4 (mockup de referência): mostrar as ~18 categorias
// inteiras cortava nome de tool pela metade, ilegível, além de deixar
// o card ENORME (desbalanceando a coluna com o resto). `countByServer()`
// (@sarah/audit) já devolve ordenado por contagem decrescente — só
// precisa cortar aqui. O resto vira uma linha "outros (N categorias)"
// agregada (soma das contagens), não simplesmente descartado.
const TOP_CATEGORIES_LIMIT = 6;

function renderCategories(container, categoryCounts) {
  container.innerHTML = "";
  if (!categoryCounts || categoryCounts.length === 0) {
    container.appendChild(el("div", "empty-panel", "nenhuma ação registrada ainda"));
    return;
  }

  const top = categoryCounts.slice(0, TOP_CATEGORIES_LIMIT);
  const rest = categoryCounts.slice(TOP_CATEGORIES_LIMIT);
  const rows = rest.length > 0
    ? [...top, { server: `outros (${rest.length} categorias)`, count: rest.reduce((sum, c) => sum + c.count, 0), isOther: true }]
    : top;

  const max = Math.max(...rows.map((c) => c.count));
  for (const cat of rows) {
    const row = el("div", "category-row");
    const labelText = cat.isOther ? cat.server : cat.server.replace("sarah-", "");
    const labelEl = el("span", "label", labelText);
    // Nome completo via tooltip (pedido como "se for fácil de
    // adicionar" — já temos o valor cru, então só um atributo a mais).
    // "outros" não tem um nome único pra mostrar, então não ganha title.
    if (!cat.isOther) labelEl.title = labelText;
    row.appendChild(labelEl);
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
 * Fase 7 parte 2 (observabilidade): últimas falhas REAIS de execução
 * (`status = 'error'` no audit log, preenchido pelos hooks
 * PostToolUse/PostToolUseFailure — ver @sarah/core). Vazio é o estado
 * normal/esperado (a maioria das chamadas funciona), não um "sem dado
 * disponível" — mensagem própria pra deixar isso claro.
 *
 * Fase 7 parte 2, peça 3 (alertas proativos): `repeatedFailures` (uma
 * tool cujas últimas N chamadas foram TODAS erro — ver
 * `AuditLog.repeatedFailures`) ganha um banner de alerta ACIMA da
 * lista normal de erros, mais chamativo que uma linha comum — é
 * exatamente o sinal que não deve passar despercebido só porque o
 * usuário não abriu o painel a tempo de ver cada erro isolado. Este
 * painel já é reconstruído a cada resposta da SARAH (`refreshDashboard`,
 * chamado depois de cada turno) — é o canal visual mais "proativo"
 * possível numa UI pull-based, sem inventar notificação nova do zero.
 */
// Dashboard v4: painel não pode crescer sem fim (era a lista inteira
// de `recentErrors`, hoje até 5 vindos do backend — ver
// `packages/core/src/index.ts`) nem mostrar o texto de erro CRU
// completo (mensagens de API costumam ter várias linhas/JSON solto).
// Mostra só os 3 mais relevantes: alertas de falha repetida primeiro
// (são o sinal mais urgente), depois erros isolados recentes até
// completar 3 — nunca repete a MESMA tool nas duas listas.
const MAX_ERROR_ROWS = 3;
const MAX_ERROR_MESSAGE_CHARS = 70;

/** Uma linha só, sem quebra/espaço duplicado, cortada com "…" se passar do limite — nunca o texto cru completo. */
function shortenErrorMessage(message) {
  const oneLine = String(message ?? "").replace(/\s+/g, " ").trim();
  if (oneLine.length <= MAX_ERROR_MESSAGE_CHARS) return oneLine;
  return `${oneLine.slice(0, MAX_ERROR_MESSAGE_CHARS - 1)}…`;
}

function renderErrors(container, recentErrors, repeatedFailures) {
  container.innerHTML = "";

  const failures = repeatedFailures ?? [];
  const failureToolNames = new Set(failures.map((f) => f.toolName));
  const errors = (recentErrors ?? []).filter((e) => !failureToolNames.has(e.toolName));

  const rows = [
    ...failures.map((f) => ({ kind: "failure", data: f })),
    ...errors.map((e) => ({ kind: "error", data: e })),
  ].slice(0, MAX_ERROR_ROWS);

  if (rows.length === 0) {
    container.appendChild(el("div", "empty-panel", "nenhum erro registrado"));
    return;
  }

  for (const { kind, data } of rows) {
    if (kind === "failure") {
      const alert = el("div", "repeated-failure-alert");
      alert.appendChild(el("span", "dot"));
      const content = el("div", "content");
      content.appendChild(
        el("div", "tool", `${data.count}× seguidas — ${data.toolName.replace(/^mcp__/, "").replace(/__/g, " · ")}`)
      );
      content.appendChild(el("div", "message", shortenErrorMessage(data.lastError)));
      alert.appendChild(content);
      alert.title = `${new Date(data.lastTimestamp).toLocaleString("pt-BR")} — ${data.lastError}`;
      container.appendChild(alert);
    } else {
      const row = el("div", "error-row");
      row.appendChild(el("span", "dot"));
      const content = el("div", "content");
      content.appendChild(el("div", "tool", data.toolName.replace(/^mcp__/, "").replace(/__/g, " · ")));
      content.appendChild(el("div", "message", shortenErrorMessage(data.errorMessage)));
      row.appendChild(content);
      row.title = `${new Date(data.timestamp).toLocaleString("pt-BR")} — ${data.errorMessage}`;
      container.appendChild(row);
    }
  }
}

/**
 * Busca e renderiza os cinco painéis de uma vez. Chamado no carregamento
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
  renderErrors(document.querySelector("#panel-errors .body"), data.recentErrors, data.repeatedFailures);
}
