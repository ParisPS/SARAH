import { runEventKitBridge } from "./bridge.js";

/**
 * Status REAL de autorização do Apple Calendar — chama o comando
 * `status` do bridge JXA (ver native/eventkit-bridge.js), que consulta
 * `EKEventStore.authorizationStatusForEntityType` SEM pedir acesso
 * (método de classe, sem efeito colateral, sem diálogo de permissão).
 * Mapeamento de `EKAuthorizationStatus` conforme a API pública da
 * Apple: 0 notDetermined, 1 restricted, 2 denied, 3 fullAccess
 * (`authorized`, valor já visto rodando de verdade nesta máquina em
 * fases anteriores), 4 writeOnly.
 */
export async function checkCalendarStatus(): Promise<{ configured: boolean; detail: string }> {
  try {
    const result = (await runEventKitBridge({ command: "status" })) as { ok: boolean; status?: number };
    if (!result.ok || typeof result.status !== "number") {
      return { configured: false, detail: "resposta inesperada da ponte EventKit" };
    }
    switch (result.status) {
      case 3:
      case 4:
        return { configured: true, detail: "acesso ao Calendário concedido" };
      case 0:
        return { configured: false, detail: "acesso ainda não solicitado (primeira chamada real pede)" };
      case 2:
        return { configured: false, detail: "acesso ao Calendário negado pelo usuário" };
      case 1:
        return { configured: false, detail: "acesso restrito (gerenciado por perfil/MDM)" };
      default:
        return { configured: false, detail: `status desconhecido: ${result.status}` };
    }
  } catch (err) {
    return { configured: false, detail: err instanceof Error ? err.message : String(err) };
  }
}
