/**
 * Ponte pro EventKit via JXA (JavaScript for Automation), chamada via
 * `osascript -l JavaScript eventkit-bridge.js`.
 *
 * Por quê JXA e não Swift compilado: esta máquina tem o Command Line
 * Tools instalado mas incompleto (xcrun/swiftc não funcionam — sem
 * Xcode.app). JXA tem acesso nativo ao EventKit via ponte
 * Objective-C (`ObjC.import`) e já vem em qualquer Mac, sem precisar
 * compilar nada. Ver docs/architecture.md pro registro completo dessa
 * decisão.
 *
 * Protocolo: um comando JSON é lido inteiro do stdin, um resultado
 * JSON é escrito no stdout. SEMPRE imprime JSON válido (mesmo em erro
 * esperado, tipo acesso negado) — erros inesperados também são
 * capturados e viram `{ ok: false, error: "..." }` em vez de deixar o
 * processo morrer sem stdout.
 *
 * Comandos suportados:
 *   { command: "list_events", startDate, endDate }   (ISO 8601)
 *   { command: "create_event", title, startDate, endDate, notes?, location?, calendarName? }
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

function toNSDate(isoString) {
  const ms = Date.parse(isoString);
  if (Number.isNaN(ms)) {
    throw new Error(`data inválida (esperado ISO 8601): ${isoString}`);
  }
  return $.NSDate.dateWithTimeIntervalSince1970(ms / 1000);
}

function toISOString(nsDate) {
  if (!nsDate) return null;
  return new Date(nsDate.timeIntervalSince1970 * 1000).toISOString();
}

function nsStringOrNull(value) {
  return value && value.js !== undefined ? value.js : null;
}

/**
 * Pede acesso ao Calendário e espera a resposta do completion handler
 * assíncrono. JXA não roda um run loop próprio, então sincronizamos
 * com um polling curto — é o padrão usado em scripts JXA que chamam
 * APIs assíncronas do Objective-C.
 */
function requestCalendarAccess(store) {
  let granted = null;
  const completion = function (g, _err) {
    granted = g;
  };

  let usedModernApi = true;
  try {
    store.requestFullAccessToEventsCompletion(completion);
  } catch (e) {
    usedModernApi = false;
  }
  if (!usedModernApi) {
    granted = null;
    store.requestAccessToEntityTypeCompletion($.EKEntityTypeEvent, completion);
  }

  let waitedSeconds = 0;
  const timeoutSeconds = 30;
  while (granted === null && waitedSeconds < timeoutSeconds) {
    delay(0.1);
    waitedSeconds += 0.1;
  }
  if (granted === null) {
    throw new Error("timeout esperando resposta de permissão do Calendário");
  }
  return granted === true;
}

function eventToPlainObject(ev) {
  return {
    id: nsStringOrNull(ev.eventIdentifier),
    title: nsStringOrNull(ev.title),
    startDate: toISOString(ev.startDate),
    endDate: toISOString(ev.endDate),
    isAllDay: Boolean(ev.allDay),
    location: nsStringOrNull(ev.location),
    notes: nsStringOrNull(ev.notes),
    calendarName: ev.calendar ? nsStringOrNull(ev.calendar.title) : null,
  };
}

/**
 * NB: arrays vindas do Objective-C (NSArray) NÃO têm `.length` nem
 * suportam indexação direta `arr[i]` em JXA — isso silenciosamente dá
 * `undefined` em vez de erro (loops baseados em `.length` simplesmente
 * nunca executam). O jeito certo é `.count` + `.objectAtIndex(i)`.
 * Descoberto rodando de verdade nesta máquina.
 */
function findCalendarByName(store, name) {
  const calendars = store.calendarsForEntityType($.EKEntityTypeEvent);
  for (let i = 0; i < calendars.count; i++) {
    const calendar = calendars.objectAtIndex(i);
    if (nsStringOrNull(calendar.title) === name) {
      return calendar;
    }
  }
  return null;
}

function handleListEvents(store, input) {
  if (!input.startDate || !input.endDate) {
    throw new Error("list_events requer startDate e endDate");
  }
  const startDate = toNSDate(input.startDate);
  const endDate = toNSDate(input.endDate);
  const calendars = store.calendarsForEntityType($.EKEntityTypeEvent);
  const predicate = store.predicateForEventsWithStartDateEndDateCalendars(
    startDate,
    endDate,
    calendars
  );
  const events = store.eventsMatchingPredicate(predicate);

  const result = [];
  for (let i = 0; i < events.count; i++) {
    result.push(eventToPlainObject(events.objectAtIndex(i)));
  }
  return { ok: true, events: result };
}

function handleCreateEvent(store, input) {
  if (!input.title || !input.startDate || !input.endDate) {
    throw new Error("create_event requer title, startDate e endDate");
  }

  const newEvent = $.EKEvent.eventWithEventStore(store);
  newEvent.title = input.title;
  newEvent.startDate = toNSDate(input.startDate);
  newEvent.endDate = toNSDate(input.endDate);
  if (input.notes) newEvent.notes = input.notes;
  if (input.location) newEvent.location = input.location;

  let calendar = null;
  if (input.calendarName) {
    calendar = findCalendarByName(store, input.calendarName);
    if (!calendar) {
      throw new Error(`calendário não encontrado: ${input.calendarName}`);
    }
  } else {
    calendar = store.defaultCalendarForNewEvents;
  }
  newEvent.calendar = calendar;

  const errorRef = Ref();
  const success = store.saveEventSpanCommitError(newEvent, $.EKSpanThisEvent, true, errorRef);
  if (!success) {
    const nsErr = errorRef[0];
    const message = nsErr ? nsStringOrNull(nsErr.localizedDescription) : "erro desconhecido";
    throw new Error(`falha ao salvar evento: ${message}`);
  }

  return { ok: true, event: eventToPlainObject(newEvent) };
}

/**
 * NB: `console.log` em JXA escreve no STDERR, não no stdout (é um
 * canal de debug, não de saída) — descoberto rodando de verdade nesta
 * máquina: via terminal interativo os dois canais aparecem
 * misturados e enganam, mas via `child_process.spawn` (sem TTY) fica
 * óbvio que o stdout vem vazio. O jeito certo de mandar dado pro
 * stdout em `osascript -l JavaScript` é `return` a partir de `run()`
 * — o osascript imprime o valor retornado no stdout. Por isso `run()`
 * abaixo usa `return`, nunca `console.log`, pro resultado final.
 */
function run(_argv) {
  try {
    const input = readStdinJSON();
    const store = $.EKEventStore.alloc.init;

    const accessGranted = requestCalendarAccess(store);
    if (!accessGranted) {
      return JSON.stringify({
        ok: false,
        error: "calendar_access_denied",
        message: "Acesso ao Calendário negado ou não concedido pelo usuário.",
      });
    }

    let result;
    if (input.command === "list_events") {
      result = handleListEvents(store, input);
    } else if (input.command === "create_event") {
      result = handleCreateEvent(store, input);
    } else {
      result = { ok: false, error: `comando desconhecido: ${input.command}` };
    }
    return JSON.stringify(result);
  } catch (e) {
    return JSON.stringify({ ok: false, error: String((e && e.message) || e) });
  }
}
