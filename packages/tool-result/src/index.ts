/**
 * Levantamento de otimização (item Q1 — qualidade/duplicação): o padrão
 * `{content: [{type: "text", text: JSON.stringify({ok, ...})}]}` (a
 * convenção `{ok,error}` deste projeto, ver comentário grande em
 * `packages/core/src/index.ts` sobre `extractToolError`) se repetia,
 * quase idêntico, em ~43 lugares espalhados por 10 pacotes de tool —
 * cada handler com seu próprio `try/catch` reescrevendo a mesma
 * serialização. A duplicação já tinha DERIVADO em pequenas
 * inconsistências reais entre cópias (algumas tratavam erro
 * não-`Error` como `String(err)`, outras como `(err as Error).message`
 * — o segundo vira a string `"undefined"` silenciosamente pra um
 * `throw` que não é uma instância de `Error`; algumas faziam
 * pretty-print com `null, 2`, outras não). `okResult`/`errorResult`
 * substituem essas cópias por uma única implementação — mesmo formato
 * de saída (JSON pretty-printed, igual à maioria das cópias
 * existentes), sempre a variante mais segura de extrair a mensagem de
 * erro (`err instanceof Error ? err.message : String(err)`).
 *
 * Pacote deliberadamente mínimo (zero dependências) — mesmo espírito
 * de `packages/audit`/`packages/permissions`: um pedacinho de lógica
 * compartilhada entre várias tools, sem puxar nada do SDK aqui (as
 * tools continuam importando `tool`/`createSdkMcpServer` direto do
 * `@anthropic-ai/claude-agent-sdk`, como sempre).
 */

interface ToolTextResult {
  content: Array<{ type: "text"; text: string }>;
}

/**
 * Resultado de SUCESSO no formato `{ok: true, ...data}`. `data` é
 * espalhado no nível raiz do JSON (não aninhado em `data:`) — mesma
 * convenção já usada em toda cópia existente (ex.: `{ok: true, count,
 * memories}`, `{ok: true, ...result}`).
 */
export function okResult(data: Record<string, unknown> = {}): ToolTextResult {
  return { content: [{ type: "text", text: JSON.stringify({ ok: true, ...data }, null, 2) }] };
}

/**
 * Resultado de ERRO no formato `{ok: false, error: "<mensagem>"}`.
 * Aceita tanto uma mensagem pronta (validação que falhou antes de
 * qualquer chamada externa, ex.: SVG inválido) quanto o valor cru
 * capturado num `catch` (`unknown`) — nos dois casos vira uma string
 * legível, nunca `"undefined"` silencioso pra um erro não-`Error`.
 */
export function errorResult(err: unknown): ToolTextResult {
  const message = typeof err === "string" ? err : err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: message }, null, 2) }] };
}
