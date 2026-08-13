// Metadado por PREFIXO de tool (`mcp__<server>__<tool>`) — emoji + nome
// amigável da integração + `sphereTask` (categoria de animação do
// núcleo da esfera, ou `null` se essa tool não tem reação própria).
// Extraído de `renderer.js` (Fase 4 parte 2, voz) pra ser compartilhado
// com `history.js` — antes só existia dentro do renderer principal,
// mas o selo de tool por mensagem migrou pro painel de histórico
// junto com a conversa (a janela principal não lista mais mensagens
// por padrão), então os dois lugares precisam do mesmo mapeamento —
// duplicar a lista seria um jeito fácil de deixar as duas divergirem.
// Entradas mais específicas (uma tool exata, como `create_event`) e
// mais genéricas (o server inteiro) convivem na mesma lista —
// `metaForTool` escolhe o prefixo mais LONGO que bate, então a
// específica sempre vence sem precisar de ordem especial.
export const TOOL_META = [
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

export function metaForTool(toolName) {
  let best = null;
  for (const meta of TOOL_META) {
    if (toolName.startsWith(meta.prefix) && (!best || meta.prefix.length > best.prefix.length)) {
      best = meta;
    }
  }
  return best ?? { emoji: "", name: toolName, sphereTask: null };
}
