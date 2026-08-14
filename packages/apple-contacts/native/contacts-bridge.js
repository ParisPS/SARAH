/**
 * Ponte pro Contacts.app via JXA, chamada via `osascript -l JavaScript
 * contacts-bridge.js` — mesmo protocolo dos outros bridges deste
 * projeto (JSON no stdin/stdout via subprocess `osascript`). Por
 * baixo, mesmo mecanismo do Notes.app (Fase 3): scripting via
 * `Application("Contacts")` (Apple Events/Automation), NÃO o
 * framework `Contacts`/`CNContactStore` que apps nativos usam — os
 * dois são vias de acesso DIFERENTES no macOS, testado de verdade
 * antes de escrever este arquivo: `ObjC.import("Contacts")` +
 * `CNContactStore.authorizationStatusForEntityType` devolveu
 * `notDetermined` (0) nesta mesma máquina onde `Application("Contacts")
 * .people()` já funcionava sem pedir nada — confirma que são gates de
 * permissão separados, e que ESTE bridge (scripting) usa Automation,
 * igual Notes, não a permissão formal de Contatos que apps Swift/ObjC
 * pedem.
 *
 * Quirk real encontrado testando contra o app de verdade: `label()` de
 * telefone/e-mail vem no formato interno do AddressBook
 * (`_$!<Mobile>!$_`, `_$!<Home>!$_`, etc.), não o texto legível
 * ("Mobile"/"Home") — `cleanLabel()` abaixo remove esse envelope. Uma
 * pessoa pode ter telefones/e-mails duplicados na lista real (visto
 * testando, provavelmente artefato de sincronização do iCloud) — o
 * bridge não deduplica, devolve exatamente o que o Contacts.app
 * devolve, sem inventar uma "limpeza" que o dado real não pediu.
 *
 * Comandos suportados:
 *   { command: "status" }
 *   { command: "find", query, limit? }
 */

function readStdinJSON() {
  const handle = $.NSFileHandle.fileHandleWithStandardInput;
  const data = handle.readDataToEndOfFile;
  const str = $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding).js;
  if (!str || !str.trim()) {
    throw new Error("stdin vazio — esperado um comando JSON");
  }
  return JSON.parse(str);
}

/** Remove o envelope interno `_$!<X>!$_` que o AddressBook usa pra rótulos localizados. */
function cleanLabel(label) {
  const s = String(label || "");
  const m = s.match(/^_\$!<(.+)>!\$_$/);
  return m ? m[1] : s || null;
}

function personToPlainObject(person) {
  let phones = [];
  try {
    const ph = person.phones();
    for (let i = 0; i < ph.length; i++) {
      phones.push({ label: cleanLabel(ph[i].label()), value: ph[i].value() });
    }
  } catch (e) {
    phones = [];
  }

  let emails = [];
  try {
    const em = person.emails();
    for (let i = 0; i < em.length; i++) {
      emails.push({ label: cleanLabel(em[i].label()), value: em[i].value() });
    }
  } catch (e) {
    emails = [];
  }

  let id = null;
  try {
    id = person.id();
  } catch (e) {
    id = null;
  }

  return { id, name: person.name(), phones, emails };
}

/**
 * Busca por SUBSTRING, case-insensitive, no nome — em JS depois de
 * buscar `Contacts.people()` inteiro, não via `.whose()` (que outros
 * bridges deste projeto também evitam, mesmo espírito de filtro manual
 * já usado em `native/notes-bridge.js` pra pasta de lixeira). Contas
 * pessoais normalmente têm no máximo algumas centenas de contatos —
 * performance não é motivo real pra complicar com `.whose()`.
 */
function handleFind(Contacts, input) {
  if (!input.query) {
    throw new Error("find requer query");
  }
  const limit = input.limit && input.limit > 0 ? input.limit : 10;
  const needle = String(input.query).toLowerCase();

  const all = Contacts.people();
  const matches = [];
  const count = all.length;
  for (let i = 0; i < count && matches.length < limit; i++) {
    const person = all[i];
    let name = "";
    try {
      name = person.name() || "";
    } catch (e) {
      continue;
    }
    if (name.toLowerCase().indexOf(needle) !== -1) {
      matches.push(personToPlainObject(person));
    }
  }

  return { ok: true, contacts: matches };
}

/**
 * `status`: mesma ideia do Notes.app (ver native/notes-bridge.js) —
 * sem API de autorização consultável pra ESTE caminho de acesso
 * (scripting/Automation, não CNContactStore, ver comentário no topo),
 * a checagem mínima e não-destrutiva é perguntar o próprio nome do
 * app via Apple Events. Se a Automation ainda não foi autorizada, isso
 * dispara o MESMO diálogo que qualquer uso real dispararia — não é um
 * efeito colateral A MAIS.
 */
function handleStatus() {
  const Contacts = Application("Contacts");
  Contacts.includeStandardAdditions = false;
  const name = Contacts.name();
  return { ok: true, name };
}

function run(_argv) {
  try {
    const input = readStdinJSON();

    if (input.command === "status") {
      return JSON.stringify(handleStatus());
    }

    const Contacts = Application("Contacts");
    Contacts.includeStandardAdditions = false;

    let result;
    if (input.command === "find") {
      result = handleFind(Contacts, input);
    } else {
      result = { ok: false, error: `comando desconhecido: ${input.command}` };
    }
    return JSON.stringify(result);
  } catch (e) {
    return JSON.stringify({ ok: false, error: String((e && e.message) || e) });
  }
}
