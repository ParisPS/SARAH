import { runNotesBridge } from "./bridge.js";

/**
 * Status REAL do Apple Notes — não existe uma API de autorização
 * consultável (Automation/Apple Events não expõe "só me diga, sem
 * pedir", diferente do EventKit). O sinal real mais próximo é chamar
 * `status` no bridge (ver native/notes-bridge.js), que só pergunta o
 * nome do app via Apple Events — se a Automation não tiver sido
 * autorizada, essa chamada lança um erro capturável (o Notes.app
 * scripting já se comporta assim, documentado desde a Fase 3).
 */
export async function checkNotesStatus(): Promise<{ configured: boolean; detail: string }> {
  try {
    const result = (await runNotesBridge({ command: "status" })) as { ok: boolean; name?: string };
    if (result.ok) {
      return { configured: true, detail: "Automation autorizada (Notes respondeu)" };
    }
    return { configured: false, detail: "Notes.app não respondeu à automação" };
  } catch (err) {
    return { configured: false, detail: err instanceof Error ? err.message : String(err) };
  }
}
