/**
 * Ponte pro Notes.app via JXA, chamada via `osascript -l JavaScript
 * notes-bridge.js`. MESMO mecanismo de invocação dos outros bridges
 * deste projeto (JSON no stdin/stdout via um subprocess `osascript`),
 * mas por baixo é um mecanismo BEM diferente: Notes.app não tem
 * framework público equivalente ao EventKit (usado por
 * apple-calendar/apple-reminders) — só scripting via
 * `Application("Notes")`, o dicionário AppleScript do próprio app
 * exposto em JXA. Sem `ObjC.import`, sem EKEventStore, sem
 * requestAccess: é outro mecanismo do macOS inteiramente (Apple
 * Events / Automation, não EventKit), com armadilhas próprias
 * encontradas testando contra o app real, não documentadas em lugar
 * nenhum de antemão:
 *
 *  - **O "nome" (título) de uma nota E a primeira linha do `body` são
 *    A MESMA COISA** — não dois campos independentes como em Reminders
 *    (title vs body separados). Ao criar `Notes.Note({name, body})`,
 *    o Notes.app AUTOMATICAMENTE insere `name` como a primeira linha
 *    (`<div>`) do body, mesmo que o body passado não a contenha. Por
 *    isso este bridge NUNCA inclui o título dentro do `body` que
 *    monta — só o conteúdo, deixando o Notes.app prepender o título
 *    sozinho. Do lado da leitura, o mesmo raciocínio ao contrário: pra
 *    devolver "conteúdo" sem repetir o título, remove a primeira linha
 *    de `plaintext()`.
 *  - **`body` é interpretado como HTML de verdade**, não texto puro —
 *    testado passando `<tag>`/`&`/aspas sem escapar: a tag some
 *    (interpretada como marcação inválida e descartada) e os
 *    caracteres especiais corrompem o HTML. Por isso todo conteúdo do
 *    usuário passa por `escapeHtml()` antes de virar body.
 *  - **Quebra de linha real (`\n`) dentro da string do body NÃO cria
 *    parágrafos separados** — testado: todas as linhas colapsam numa
 *    linha só, separadas por espaço. É preciso converter pra `<br>`
 *    explicitamente (depois de escapar, senão o `<br>` também seria
 *    escapado).
 *  - **Pasta não encontrada (`folders.byName(nome inexistente)`) lança
 *    um erro JS capturável** (`Can't get object.`), diferente do
 *    crash nativo incapturável do EventKit ao passar `null`/array
 *    literal em certos parâmetros (bug documentado nos bridges de
 *    apple-reminders). Aqui um `try/catch` normal já resolve.
 *  - **Não hardcoda o nome da pasta padrão** ("Notes"/"Notas" conforme
 *    idioma do sistema): criar/listar sem especificar pasta usa
 *    `account.notes`/`Notes.notes` diretamente (todas as contas/pasta
 *    padrão), sem precisar adivinhar o nome localizado.
 *
 * Escopo (mesmo princípio do apple-reminders — só o que a interface
 * pública cobre com confiança): título + corpo em texto simples +
 * pasta opcional. Sem anexos, sem formatação rica, sem tags.
 *
 * Protocolo: JSON no stdin, JSON no stdout, sempre — mesmo em erro
 * esperado (pasta não encontrada etc.).
 *
 * Comandos suportados:
 *   { command: "list_notes", folderName?, limit? }
 *   { command: "create_note", title, content?, folderName? }
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

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Monta o `body` (HTML) a partir de texto simples do usuário: escapa
 * primeiro (segurança/corretude — texto com `<`/`&`/aspas não pode
 * virar marcação), só DEPOIS converte quebra de linha em `<br>` (na
 * ordem inversa, o `<br>` literal seria escapado também).
 */
function plainTextToBody(text) {
  if (!text) return "";
  return escapeHtml(text).split("\n").join("<br>");
}

/**
 * Remove a primeira linha de `plaintext()` (que é sempre o título,
 * ver comentário no topo do arquivo) pra devolver só o conteúdo, sem
 * repetir o título que já vem em campo separado na resposta.
 */
function contentWithoutTitle(plaintext) {
  const lines = String(plaintext || "").split("\n");
  lines.shift();
  return lines.join("\n").replace(/^\n+/, "");
}

function findFolderByName(account, folderName) {
  try {
    const folder = account.folders.byName(folderName);
    folder.name(); // força a resolução — acesso a propriedade inexistente lança aqui
    return folder;
  } catch (e) {
    return null;
  }
}

function noteToPlainObject(note) {
  const plaintext = note.plaintext();
  let folderName = null;
  try {
    folderName = note.container().name();
  } catch (e) {
    folderName = null;
  }
  return {
    id: note.id(),
    title: note.name(),
    folderName,
    content: contentWithoutTitle(plaintext),
    creationDate: note.creationDate().toISOString(),
    modificationDate: note.modificationDate().toISOString(),
  };
}

// Nome da pasta-lixeira do Notes.app. Testado de verdade: `account.notes()`
// SEM filtro de pasta inclui as notas de dentro dela — não faz sentido
// pra um "liste minhas notas" comum (equivalente a listar itens
// apagados). JXA não expõe nenhuma propriedade que distinga essa pasta
// de uma pasta normal (`.class()` de EKFolder falha), só o nome — por
// isso é um filtro por STRING, com a limitação conhecida de só
// funcionar no idioma em que o nome desta pasta aparece pro usuário
// (testado em "Recently Deleted", inglês; ficaria "Recentemente
// Excluídos" ou similar em português, por exemplo). Não filtra nada se
// o usuário pedir essa pasta explicitamente por nome via `folderName`.
const TRASH_FOLDER_NAME = "Recently Deleted";

function handleListNotes(Notes, account, input) {
  const limit = input.limit && input.limit > 0 ? input.limit : 20;

  let source;
  if (input.folderName) {
    const folder = findFolderByName(account, input.folderName);
    if (!folder) {
      throw new Error(`pasta de notas não encontrada: ${input.folderName}`);
    }
    source = folder.notes();
  } else {
    source = account.notes();
  }

  const all = [];
  const count = source.length;
  for (let i = 0; i < count; i++) {
    const note = source[i];
    if (!input.folderName) {
      let folderName = null;
      try {
        folderName = note.container().name();
      } catch (e) {
        folderName = null;
      }
      if (folderName === TRASH_FOLDER_NAME) continue;
    }
    all.push(note);
  }

  all.sort((a, b) => b.modificationDate().getTime() - a.modificationDate().getTime());

  const notes = all.slice(0, limit).map(noteToPlainObject);
  return { ok: true, notes };
}

function handleCreateNote(Notes, account, input) {
  if (!input.title) {
    throw new Error("create_note requer title");
  }

  const body = plainTextToBody(input.content);
  const newNote = Notes.Note({ name: input.title, body });

  if (input.folderName) {
    const folder = findFolderByName(account, input.folderName);
    if (!folder) {
      throw new Error(`pasta de notas não encontrada: ${input.folderName}`);
    }
    folder.notes.push(newNote);
  } else {
    account.notes.push(newNote);
  }

  return { ok: true, note: noteToPlainObject(newNote) };
}

/**
 * `status`: Notes.app não tem uma API de autorização consultável como
 * o EventKit (`authorizationStatusForEntityType`) — Apple Events/
 * Automation não expõe um "só me diga se eu tenho permissão, sem
 * pedir". A checagem mais mínima e não-destrutiva possível é chamar
 * `Notes.name()` — só pergunta o próprio nome do app via Apple
 * Events, não lê nem cria nenhuma nota. Se a Automation não foi
 * autorizada ainda, isso dispara o MESMO diálogo de permissão que
 * qualquer uso real dispararia na primeira vez (não é um efeito
 * colateral A MAIS que este status check está introduzindo) — só não
 * cria/edita dado nenhum.
 */
function handleStatus() {
  const Notes = Application("Notes");
  Notes.includeStandardAdditions = false;
  const name = Notes.name(); // só pra confirmar que a automação responde
  return { ok: true, name };
}

function run(_argv) {
  try {
    const input = readStdinJSON();

    if (input.command === "status") {
      return JSON.stringify(handleStatus());
    }

    const Notes = Application("Notes");
    Notes.includeStandardAdditions = false;
    const account = Notes.defaultAccount();

    let result;
    if (input.command === "list_notes") {
      result = handleListNotes(Notes, account, input);
    } else if (input.command === "create_note") {
      result = handleCreateNote(Notes, account, input);
    } else {
      result = { ok: false, error: `comando desconhecido: ${input.command}` };
    }
    return JSON.stringify(result);
  } catch (e) {
    return JSON.stringify({ ok: false, error: String((e && e.message) || e) });
  }
}
