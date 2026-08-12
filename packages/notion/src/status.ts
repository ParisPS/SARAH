/**
 * Status REAL de configuração do Notion — mesmo princípio de
 * `@sarah/gmail`/`status.ts`: só presença de configuração, não uma
 * chamada de verdade à API do Notion (custo de rede a cada abertura
 * do dashboard). Ver docs/architecture.md, painel "status das
 * integrações" (Fase 4 parte 3.5).
 */
export async function checkNotionStatus(): Promise<{ configured: boolean; detail: string }> {
  const hasKey = Boolean(process.env.NOTION_API_KEY?.trim());
  const hasDb = Boolean(process.env.NOTION_CALENDAR_DATABASE_ID?.trim());
  if (hasKey && hasDb) {
    return { configured: true, detail: "NOTION_API_KEY + NOTION_CALENDAR_DATABASE_ID configurados" };
  }
  const missing = [!hasKey && "NOTION_API_KEY", !hasDb && "NOTION_CALENDAR_DATABASE_ID"].filter(Boolean).join(", ");
  return { configured: false, detail: `faltando no .env: ${missing}` };
}
