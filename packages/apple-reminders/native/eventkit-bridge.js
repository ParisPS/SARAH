/**
 * Ponte pro EventKit (Reminders) via JXA, chamada via
 * `osascript -l JavaScript eventkit-bridge.js`. Mesmo padrão de
 * packages/apple-calendar/native/eventkit-bridge.js — ver lá e
 * docs/architecture.md pro porquê de JXA em vez de Swift compilado
 * (Xcode CLT quebrado nesta máquina).
 *
 * Diferenças reais do EventKit pra Reminders vs Calendar (Reminders
 * não tem os mesmos atalhos síncronos que Events tem):
 *  - Buscar reminders é só assíncrono
 *    (`fetchRemindersMatchingPredicate:completion:`) — não existe
 *    equivalente síncrono de `eventsMatchingPredicate:`.
 *  - Vencimento é `dueDateComponents` (NSDateComponents: ano/mês/
 *    dia/hora/minuto), não um NSDate como `startDate`/`endDate` de
 *    EKEvent.
 *  - Identificador estável é `calendarItemIdentifier`, não
 *    `eventIdentifier` (esse é específico de EKEvent).
 *  - Lista padrão: `defaultCalendarForNewReminders` (accessor
 *    próprio, análogo a `defaultCalendarForNewEvents`).
 *
 * Protocolo: JSON no stdin, JSON no stdout, sempre — mesmo em erro
 * esperado (acesso negado, lista não encontrada etc.).
 *
 * Comandos suportados:
 *   { command: "list_reminders", listName? }
 *   { command: "create_reminder", title, listName?, dueDate? }   (dueDate em ISO 8601)
 */

ObjC.import("EventKit");
ObjC.import("Foundation");

function readStdinJSON() {
  const handle = $.NSFileHandle.fileHandleWithStandardInput;
  const data = handle.readDataToEndOfFile;
  const str = $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding).js;
  if (!str || !str.trim()) {
    throw new Error("stdin vazio — esperado um comando JSON");
  }
  return JSON.parse(str);
}

function nsStringOrNull(value) {
  return value && value.js !== undefined ? value.js : null;
}

/**
 * Espera uma chamada assíncrona do Objective-C terminar, com o mesmo
 * polling curto usado em requestAccess (JXA não tem run loop próprio
 * pra pumping de completion handlers). Reaproveitado aqui tanto pro
 * pedido de permissão quanto pro fetch de reminders — os dois únicos
 * pontos assíncronos deste script.
 */
function waitForCallback(startAsyncCall, timeoutSeconds) {
  let done = false;
  let value;
  startAsyncCall((v) => {
    done = true;
    value = v;
  });
  let waited = 0;
  while (!done && waited < timeoutSeconds) {
    delay(0.1);
    waited += 0.1;
  }
  if (!done) {
    throw new Error("timeout esperando resposta assíncrona do EventKit");
  }
  return value;
}

function requestRemindersAccess(store) {
  let usedModernApi = true;
  let granted;
  try {
    granted = waitForCallback(
      (done) => store.requestFullAccessToRemindersCompletion((g, _err) => done(g)),
      30
    );
  } catch (e) {
    usedModernApi = false;
  }
  if (!usedModernApi) {
    granted = waitForCallback(
      (done) => store.requestAccessToEntityTypeCompletion($.EKEntityTypeReminder, (g, _err) => done(g)),
      30
    );
  }
  return granted === true;
}

/**
 * NSDateComponents usa o sentinel NSDateComponentUndefined
 * (NSIntegerMax) pra campo "não definido" — precisa ser detectado
 * explicitamente, não vem como undefined/null em JXA.
 */
/**
 * NB: um `NSDateComponents` recém-criado por nós (`alloc.init`) e
 * atribuído a uma reminder devolve `.year`/`.month`/etc como STRING
 * ("2026") ao ler de volta no mesmo processo — só um componente
 * vindo de um objeto buscado do store devolve number de verdade. Sem
 * coagir com `Number()` aqui, `typeof value === "number"` falhava
 * silenciosamente pra todo lembrete recém-criado e `dueDate` sempre
 * voltava `null`, mesmo com o valor salvo certinho no EventKit (visto
 * direto pela API). Descoberto rodando de verdade — `Number(x)` num
 * valor NSDateComponentUndefined (sentinel gigante) continua um
 * número gigante, então o filtro de "não definido" abaixo continua
 * funcionando igual.
 */
function isComponentDefined(value) {
  const n = Number(value);
  return Number.isFinite(n) && Math.abs(n) < 1e15;
}

function toDueDateComponents(isoString) {
  const d = new Date(isoString);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`data inválida (esperado ISO 8601): ${isoString}`);
  }
  // Componentes em horário LOCAL (não UTC): dueDateComponents é uma
  // data "de calendário" (o que aparece no app Reminders), não um
  // instante absoluto — construir a partir do wall-clock local do
  // instante recebido é o que faz o Reminders mostrar a mesma hora
  // que o usuário pediu.
  const comps = $.NSDateComponents.alloc.init;
  comps.year = d.getFullYear();
  comps.month = d.getMonth() + 1;
  comps.day = d.getDate();
  comps.hour = d.getHours();
  comps.minute = d.getMinutes();
  return comps;
}

function dueDateComponentsToISOString(comps) {
  if (!comps) return null;
  const year = Number(comps.year);
  const month = Number(comps.month);
  const day = Number(comps.day);
  if (!isComponentDefined(year) || !isComponentDefined(month) || !isComponentDefined(day)) {
    return null;
  }
  const hour = isComponentDefined(comps.hour) ? Number(comps.hour) : 0;
  const minute = isComponentDefined(comps.minute) ? Number(comps.minute) : 0;
  return new Date(year, month - 1, day, hour, minute, 0).toISOString();
}

function reminderToPlainObject(rem) {
  return {
    id: nsStringOrNull(rem.calendarItemIdentifier),
    title: nsStringOrNull(rem.title),
    listName: rem.calendar ? nsStringOrNull(rem.calendar.title) : null,
    dueDate: dueDateComponentsToISOString(rem.dueDateComponents),
    completed: Boolean(rem.completed),
  };
}

function findReminderListByName(store, name) {
  const lists = store.calendarsForEntityType($.EKEntityTypeReminder);
  for (let i = 0; i < lists.count; i++) {
    const list = lists.objectAtIndex(i);
    if (nsStringOrNull(list.title) === name) {
      return list;
    }
  }
  return null;
}

function handleListReminders(store, input) {
  // NB, as duas descobertas rodando de verdade: 1) passar `null` de JS
  // pro parâmetro `calendars` (um NSArray) vira NSNull em JXA, não nil
  // de verdade — o EventKit crasha (`-[NSNull count]: unrecognized
  // selector`). 2) um ARRAY LITERAL do JS (`[list]`) envolvendo um
  // objeto nativo TAMBÉM crasha nesse mesmo método interno do
  // EventKit (`remListIDsWithAllLists:`) — só um NSArray "de
  // verdade" (`$.NSArray.arrayWithObject`) funciona. Por isso nunca
  // passa null nem array literal aqui, só NSArray nativo.
  const calendars = input.listName
    ? (() => {
        const list = findReminderListByName(store, input.listName);
        if (!list) {
          throw new Error(`lista de lembretes não encontrada: ${input.listName}`);
        }
        return $.NSArray.arrayWithObject(list);
      })()
    : store.calendarsForEntityType($.EKEntityTypeReminder);

  // NB (terceira descoberta rodando de verdade): o EventKit não tem
  // um predicate pronto pra "todo incomplete reminder, com ou sem
  // data de vencimento" — `predicateForIncompleteRemindersWithDueDate...`
  // exige por definição que o lembrete TENHA vencimento (exclui os
  // que não têm), e passar `null` nos parâmetros de data desse
  // predicate não significa "sem limite": a busca simplesmente não
  // devolve nada (`undefined`), em vez de dar erro. Por isso aqui usa
  // `predicateForRemindersInCalendars` (todos, completos ou não, com
  // ou sem data) e filtra `completed` no JS — cobre lembrete sem
  // vencimento também, que é um caso real (testado: "Teste bridge
  // isolado sem data" só aparecia com essa mudança).
  const predicate = store.predicateForRemindersInCalendars(calendars);

  const reminders = waitForCallback(
    (done) => store.fetchRemindersMatchingPredicateCompletion(predicate, (r) => done(r)),
    30
  );

  const result = [];
  if (reminders) {
    for (let i = 0; i < reminders.count; i++) {
      const reminder = reminders.objectAtIndex(i);
      if (Boolean(reminder.completed)) continue;
      result.push(reminderToPlainObject(reminder));
    }
  }
  return { ok: true, reminders: result };
}

function handleCreateReminder(store, input) {
  if (!input.title) {
    throw new Error("create_reminder requer title");
  }

  const reminder = $.EKReminder.reminderWithEventStore(store);
  reminder.title = input.title;

  let list = null;
  if (input.listName) {
    list = findReminderListByName(store, input.listName);
    if (!list) {
      throw new Error(`lista de lembretes não encontrada: ${input.listName}`);
    }
  } else {
    list = store.defaultCalendarForNewReminders;
  }
  reminder.calendar = list;

  if (input.dueDate) {
    reminder.dueDateComponents = toDueDateComponents(input.dueDate);
  }

  const errorRef = Ref();
  const success = store.saveReminderCommitError(reminder, true, errorRef);
  if (!success) {
    const nsErr = errorRef[0];
    const message = nsErr ? nsStringOrNull(nsErr.localizedDescription) : "erro desconhecido";
    throw new Error(`falha ao salvar lembrete: ${message}`);
  }

  return { ok: true, reminder: reminderToPlainObject(reminder) };
}

function run(_argv) {
  try {
    const input = readStdinJSON();
    const store = $.EKEventStore.alloc.init;

    const accessGranted = requestRemindersAccess(store);
    if (!accessGranted) {
      return JSON.stringify({
        ok: false,
        error: "reminders_access_denied",
        message: "Acesso aos Lembretes negado ou não concedido pelo usuário.",
      });
    }

    let result;
    if (input.command === "list_reminders") {
      result = handleListReminders(store, input);
    } else if (input.command === "create_reminder") {
      result = handleCreateReminder(store, input);
    } else {
      result = { ok: false, error: `comando desconhecido: ${input.command}` };
    }
    return JSON.stringify(result);
  } catch (e) {
    return JSON.stringify({ ok: false, error: String((e && e.message) || e) });
  }
}
