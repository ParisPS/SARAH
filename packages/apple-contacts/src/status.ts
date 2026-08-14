import { runContactsBridge } from "./bridge.js";

/**
 * Status REAL do Apple Contacts — mesma lógica de `checkNotesStatus`
 * (`@sarah/apple-notes`): sem API de autorização consultável pro
 * caminho de acesso que este pacote usa (scripting/Automation, ver
 * comentário no topo de `native/contacts-bridge.js` — não é o mesmo
 * gate que `CNContactStore`, testado de verdade antes de decidir
 * isso). O sinal real mais próximo é chamar `status`, que só pergunta
 * o nome do app via Apple Events.
 */
export async function checkContactsStatus(): Promise<{ configured: boolean; detail: string }> {
  try {
    const result = (await runContactsBridge({ command: "status" })) as { ok: boolean; name?: string };
    if (result.ok) {
      return { configured: true, detail: "Automation autorizada (Contacts respondeu)" };
    }
    return { configured: false, detail: "Contacts.app não respondeu à automação" };
  } catch (err) {
    return { configured: false, detail: err instanceof Error ? err.message : String(err) };
  }
}
