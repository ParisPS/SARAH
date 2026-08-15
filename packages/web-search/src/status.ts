/**
 * Status REAL de configuração da busca de preços — mesmo princípio de
 * `@sarah/notion`/`@sarah/gmail`/`status.ts`: só presença da env var,
 * nunca uma chamada de verdade à Serper.dev (custo de cota a cada
 * abertura do dashboard). Ver docs/architecture.md, painel "status
 * das integrações" (Fase 4 parte 3.5).
 */
export async function checkWebSearchStatus(): Promise<{ configured: boolean; detail: string }> {
  const hasKey = Boolean(process.env.SERPER_API_KEY?.trim());
  if (hasKey) {
    return { configured: true, detail: "SERPER_API_KEY configurada" };
  }
  return { configured: false, detail: "faltando no .env: SERPER_API_KEY" };
}
