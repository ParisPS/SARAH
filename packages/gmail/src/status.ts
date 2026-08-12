import { getRefreshToken } from "./keychain.js";

/**
 * Status REAL de configuração do Gmail, pro painel de "status das
 * integrações" do dashboard (Fase 4 parte 3.5) — NUNCA um indicador
 * decorativo. Checa só o que dá pra checar sem custo/latência real:
 * as duas env vars (`GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`) e se
 * existe um refresh token salvo no Keychain. Isso é "configurado",
 * não "testado agora" — uma chamada de verdade à API do Google (pra
 * confirmar que o token ainda é válido) teria custo de rede a cada
 * vez que o dashboard fosse aberto, então não faz parte deste check.
 * Se o token tiver expirado (ver docs/architecture.md sobre o modo
 * "Testing" do OAuth, ~7 dias), o status aqui continua "configurado"
 * até o usuário tentar usar de verdade e ver o erro de
 * `invalid_grant` — é uma limitação conhecida, não um bug.
 */
export async function checkGmailStatus(): Promise<{ configured: boolean; detail: string }> {
  const hasEnv = Boolean(process.env.GOOGLE_CLIENT_ID?.trim() && process.env.GOOGLE_CLIENT_SECRET?.trim());
  if (!hasEnv) {
    return { configured: false, detail: "GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET não configurados no .env" };
  }
  try {
    await getRefreshToken();
    return { configured: true, detail: "credenciais + refresh token no Keychain" };
  } catch {
    return { configured: false, detail: "sem refresh token no Keychain — rode `pnpm gmail:auth`" };
  }
}
