import { runEventKitBridge } from "./bridge.js";

/**
 * Status REAL de autorização do Apple Reminders — mesmo mecanismo de
 * `@sarah/apple-calendar/status.ts` (ver comentário lá), só que pra
 * `EKEntityTypeReminder`.
 */
export async function checkRemindersStatus(): Promise<{ configured: boolean; detail: string }> {
  try {
    const result = (await runEventKitBridge({ command: "status" })) as { ok: boolean; status?: number };
    if (!result.ok || typeof result.status !== "number") {
      return { configured: false, detail: "resposta inesperada da ponte EventKit" };
    }
    switch (result.status) {
      case 3:
      case 4:
        return { configured: true, detail: "acesso aos Lembretes concedido" };
      case 0:
        return { configured: false, detail: "acesso ainda não solicitado (primeira chamada real pede)" };
      case 2:
        return { configured: false, detail: "acesso aos Lembretes negado pelo usuário" };
      case 1:
        return { configured: false, detail: "acesso restrito (gerenciado por perfil/MDM)" };
      default:
        return { configured: false, detail: `status desconhecido: ${result.status}` };
    }
  } catch (err) {
    return { configured: false, detail: err instanceof Error ? err.message : String(err) };
  }
}
