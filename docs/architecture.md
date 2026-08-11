# SARAH — contexto de arquitetura

Este arquivo existe pra qualquer sessão nova (inclusive o Claude Code)
ter o contexto das decisões já tomadas, sem precisar re-explicar tudo.

## O que é este projeto

Assistente pessoal estilo SARAH: um agente (Claude Agent SDK) que
executa ações em serviços externos (Notion, Apple Reminders/Notes/
Calendar, e-mail, GitHub, web) através de um sistema de tools
modulares, com um Gateway de permissões baseado em risco na frente de
toda execução.

## Decisões de arquitetura já tomadas

- **Roda localmente no Mac**, não como serviço cloud — Apple
  Reminders/Notes/Calendar não têm API na nuvem (só EventKit local,
  AppleScript, Shortcuts CLI), então o orquestrador precisa estar na
  mesma máquina.
- **Stack:** TypeScript + Node + Claude Agent SDK
  (`@anthropic-ai/claude-agent-sdk`) como motor do agente — ele já
  expõe o loop de agente, tools, MCP e sistema de permissões do
  Claude Code.
- **Monorepo com pnpm workspaces**, um pacote por responsabilidade
  (ver estrutura abaixo). Cada integração externa é um pacote
  isolado implementando o mesmo formato de tool — baixo acoplamento,
  fácil adicionar serviço novo sem tocar no resto.
- **Risco NÃO vive dentro da tool.** Uma política central
  (`@sarah/permissions`) classifica o risco de cada chamada (`low` |
  `high`) e decide se pede confirmação — a tool só sabe executar.
  Padrão fail-safe: tool desconhecida = alto risco até ser
  explicitamente classificada como baixa.
- **`data/sarah.db`** (SQLite) é o log de auditoria — toda decisão do
  Gateway é gravada lá.
- **Desambiguação entre tools equivalentes (ex.: dois calendários) é
  feita só pela `description` de cada tool, sem roteador central.** O
  Agent SDK não expõe um jeito de "escolher entre tools do MCP" fora
  do próprio LLM lendo as descriptions — então quando duas tools fazem
  a mesma coisa em serviços diferentes (`apple_calendar.create_event`
  vs `notion.create_event`), a regra de "qual usar quando" (padrão,
  gatilhos explícitos, nunca chamar as duas juntas) precisa estar
  escrita, de forma simétrica, nas duas descriptions. Não existe outro
  lugar no código pra essa lógica morar.

## Estrutura do repositório

```
jarvis/                  # nome da pasta no disco — não renomeada (só o
                          # projeto/pacotes/nomes funcionais, ver seção
                          # "Renomeação: JARVIS → SARAH" mais abaixo)
  apps/cli/              # interface MVP (terminal)
  packages/
    core/                 # orquestrador: chama query() do Agent SDK
    permissions/           # Gateway: classifyRisk() + canUseTool
    audit/                  # log de decisões em SQLite
    fixtures/                # tools de teste (ping / pretend_delete)
    apple-calendar/           # Fase 1: Apple Calendar via EventKit (ponte JXA)
    notion/                   # Fase 1: Notion Calendar (API REST oficial, sem SDK)
    apple-reminders/          # Fase 1: Apple Reminders via EventKit (ponte JXA)
    gmail/                     # Fase 1: Gmail (leitura, OAuth próprio) — fecha a Fase 1
  scripts/
    gmail-auth.ts              # autorização OAuth interativa (roda uma vez): `pnpm gmail:auth`
```

## Bugs já encontrados e corrigidos na Fase 0

Isso importa porque são armadilhas reais do SDK, não teoria:

1. **`tsx watch` reiniciava o processo sozinho.** O audit log escreve
   dentro da pasta observada pelo watch mode, então cada tool call
   disparava um restart. Corrigido: `dev` roda sem `watch`
   (`apps/cli/package.json`). Não usar watch mode aqui de propósito —
   é um REPL com estado (SQLite aberto, sessão), reiniciar sozinho no
   meio nunca é o que se quer.

2. **`allowedTools` pulava o Gateway.** Um nome "solto" em
   `allowedTools` pré-aprova a tool inteira ANTES do `canUseTool` ser
   consultado (o SDK avisa isso com o warning
   `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED`). Resultado: a tool de alto
   risco executava sem pedir confirmação nenhuma. Corrigido: as tools
   de teste saíram de `allowedTools`; agora toda chamada cai
   naturalmente no `canUseTool`. `disallowedTools` bloqueia as tools
   nativas do agente (Bash, Write, Edit etc.) que ainda não devem
   existir nessa fase.

## Decisões e bugs encontrados na Fase 1 (Apple Calendar)

1. **Swift compilado foi descartado como ponte — Xcode Command Line
   Tools quebrado nesta máquina.** O plano original previa um helper
   Swift pequeno compilado localmente. Testado na hora: `swiftc` falha
   com `xcrun: error: invalid active developer path
   (/Library/Developer/CommandLineTools), missing xcrun` — o CLT está
   instalado mas incompleto, sem `Xcode.app`, `xcodebuild` também
   falha. Consertar isso exige `xcode-select --install` (instalador
   gráfico, precisa de clique humano e minutos de download), fora do
   que dá pra terminar numa sessão automatizada.

   **Decisão:** usar **JXA (JavaScript for Automation)**, chamado via
   `osascript -l JavaScript <script>`, em vez de Swift compilado. JXA
   acessa o EventKit nativamente via ponte Objective-C
   (`ObjC.import("EventKit")`), sem precisar de compilador — já vem
   em qualquer Mac. Mesmo padrão pedido originalmente (subprocess +
   JSON via stdin/stdout), só que sem etapa de build. Ver
   `packages/apple-calendar/native/eventkit-bridge.js`. Se um dia o
   Xcode CLT for consertado nesta máquina, dá pra reavaliar migrar
   pra Swift compilado — não é necessário, só uma opção.

2. **Em JXA, `console.log` escreve no STDERR, não no stdout.**
   `console.log` é canal de debug; o valor que vira stdout de
   verdade é o **retorno** da função `run()`. Rodando o script direto
   num terminal interativo isso passa despercebido (os dois canais
   aparecem misturados), mas via `child_process.spawn` (sem TTY) o
   stdout vinha vazio e a ponte parecia estar "quebrada". Corrigido:
   `run()` agora faz `return JSON.stringify(result)` em vez de
   `console.log(...)`.

3. **Arrays vindas do Objective-C (`NSArray`) não têm `.length` em
   JXA.** `calendars.length` retorna `undefined` silenciosamente (não
   dá erro), então um loop `for (i = 0; i < arr.length; i++)` nunca
   executa nem uma vez — parecia que `calendarsForEntityType` sempre
   devolvia uma lista vazia. O jeito certo é `.count` +
   `.objectAtIndex(i)`. Também não dá pra indexar direto (`arr[0]`
   lança `TypeError`).

4. **`rl.question()` quebra o processo se o stdin fecha no meio do
   loop.** `readline/promises` rejeita a promise com
   `ERR_USE_AFTER_CLOSE` em vez de simplesmente devolver — isso
   acontecia sempre que o stdin chegava ao EOF (pipe, Ctrl+D) entre
   uma pergunta e outra, derrubando o processo com stack trace em vez
   de encerrar normalmente. Corrigido em `packages/core/src/index.ts`:
   esse erro específico agora é tratado como "sair".

## Decisões e bugs encontrados na Fase 1 (Notion Calendar)

1. **API do Notion mudou: `database_id` sozinho não basta mais pra
   criar página.** Pesquisei a documentação atual antes de
   implementar (developers.notion.com) — desde a versão `2025-09-03`
   da API, um banco de dados pode ter múltiplas "data sources", e
   `POST /v1/pages` exige `parent.data_source_id`, não
   `parent.database_id` direto. A versão mais recente é `2026-03-11`.
   Fluxo implementado em `packages/notion/src/client.ts`:
   `GET /v1/databases/{id}` → lê `data_sources[0].id` → só então
   `POST /v1/pages` com esse `data_source_id` como parent.

2. **Nomes de propriedade não são hardcoded — são detectados pelo
   TIPO.** O pedido original previa propriedades chamadas "Título" e
   "Data". Rodando de verdade contra o banco real do usuário, a
   propriedade título se chamava **"Name"** e a de data **"Date"**
   (interface em inglês) — duas rodadas de erro `400` antes de
   perceber isso. Corrigido pra sempre: `resolveCalendarSchema()`
   procura a propriedade do tipo `title` e a do tipo `date` dentro do
   schema da data source, seja qual for o nome — todo banco do Notion
   tem exatamente uma propriedade título, e o usuário garantiu que
   tem (agora) uma propriedade de data.

3. **Nada no projeto carregava `.env` pra `process.env`.** Existia
   desde a Fase 0 mas só importava pro `ANTHROPIC_API_KEY` (que o
   Agent SDK pode pegar de uma sessão `claude login` já autenticada,
   então o problema nunca apareceu). Pra `NOTION_API_KEY`/
   `NOTION_CALENDAR_DATABASE_ID` ele é obrigatório. Corrigido em
   `apps/cli/src/main.ts`: usa `process.loadEnvFile()` (nativo do
   Node 20.12+/22, sem dependência `dotenv` nova), resolvendo o
   caminho do `.env` a partir da localização do arquivo-fonte (não do
   `cwd`), pra funcionar igual rodando via `pnpm dev` da raiz ou
   direto de `apps/cli`.

4. **`NOTION_CALENDAR_DATABASE_ID` veio colado como URL inteira**, não
   o UUID puro (o jeito mais natural de copiar um banco no Notion é
   "Copiar link", não extrair o ID à mão). `client.ts` agora aceita
   qualquer string que contenha um UUID em algum lugar
   (`extractDatabaseId`), em vez de exigir o formato exato.

Nenhum desses quatro pontos era visível só lendo a documentação do
Notion — só apareceram tentando criar uma página de verdade contra o
banco real do usuário, um erro de cada vez (`401` → `400` duas vezes
→ funcionou).

5. **Schema cacheado pra vida do processo mascarava mudanças feitas
   no Notion enquanto o `pnpm dev` já estava rodando.** Ao adicionar o
   parâmetro `categoria` (propriedade Select, nome fixo "Categoria" —
   diferente de título/data, um banco pode ter várias propriedades
   Select, então não dá pra detectar "a" certa só pelo tipo),
   `resolveCalendarSchema()` guardava o resultado numa variável em
   memória na primeira chamada e nunca mais buscava de novo. Se a
   propriedade era renomeada no Notion (de "Select" pra "Categoria")
   com um `pnpm dev` antigo ainda de pé, esse processo continuava
   achando que "Categoria" não existia — e um `create_event` com
   `categoria` preenchida falhava silenciosamente aos olhos do
   usuário (o agente via o erro da tool, tentava de novo sem
   `categoria`, e reportava sucesso sem avisar que a categoria tinha
   sido descartada no meio do caminho).

   **Diagnóstico** (sem chutar código, só olhando dado real): 1)
   `GET /v1/data_sources/{id}` confirmou a propriedade "Categoria" já
   existia, tipo `select`, com as 5 opções e cores certas; 2) log
   temporário do payload exato que a tool montava mostrou
   `{"select":{"name":"Pessoal"}}` — nome e formato batendo
   perfeitamente com o schema; 3) uma chamada isolada a
   `createCalendarEntry` (bypassando o agente) funcionou de primeira,
   e uma chamada ao vivo via `pnpm dev` também funcionou de primeira
   depois de reiniciado — isolando a causa pro cache, não pro payload.

   **Correção:** removido o cache — `resolveCalendarSchema()` busca o
   schema direto do Notion a cada `create_event`. Uma chamada HTTP
   extra por evento criado é custo desprezível pra um assistente
   pessoal; schema sempre atualizado (mesmo com o processo já de pé
   há horas) vale mais que essa micro-otimização.

## Decisões e bugs encontrados na Fase 1 (Apple Reminders)

`EKReminder` tem várias diferenças reais de `EKEvent` que só
apareceram testando de verdade contra o EventKit (não dava pra prever
só lendo a doc da API Swift — JXA deriva os nomes/comportamento via a
ponte Objective-C, que tem suas próprias armadilhas):

1. **Passar `null` de JS pro parâmetro `calendars` (um `NSArray`)
   crasha o processo `osascript` inteiro** — `-[NSNull count]:
   unrecognized selector sent to instance`. JXA converte `null` pra
   `NSNull` (um objeto real, "nulo" só por convenção), não pra `nil`
   de Objective-C — e o EventKit não espera `NSNull` num parâmetro de
   array, então crasha em vez de tratar como "sem filtro". Diferente
   de um erro capturável: derruba o `osascript` com um stack trace
   nativo, o `try/catch` do JS nem chega a rodar.

2. **Um array LITERAL do JS (`[list]`) envolvendo um objeto nativo
   TAMBÉM crasha**, no mesmo método interno
   (`remListIDsWithAllLists:`) — só um `NSArray` "de verdade"
   (`$.NSArray.arrayWithObject(list)`) funciona como parâmetro de
   lista de calendários. Regra prática adotada: nunca passar `null`
   nem array literal pra esses parâmetros do EventKit — sempre um
   `NSArray` nativo (via `arrayWithObject` ou vindo direto de outro
   método do EventKit, como `calendarsForEntityType`).

3. **`predicateForIncompleteRemindersWithDueDateStartingEndingCalendars`
   exclui por definição lembretes SEM data de vencimento** (o nome já
   diz: "with due date"), e passar `null` nos parâmetros de data não
   significa "sem limite" — a busca simplesmente devolve `undefined`
   em vez de tudo. EventKit não tem um predicate pronto pra "todo
   lembrete incompleto, com ou sem data". Corrigido usando
   `predicateForRemindersInCalendars` (busca tudo, com ou sem data,
   completo ou não) e filtrando `completed` no lado do JS.

4. **`NSDateComponents` recém-criado por nós devolve `.year`/`.month`/
   etc como STRING ao ler de volta no mesmo processo** (só um
   componente vindo de um objeto buscado do store real devolve
   `number`). Isso fazia `typeof value === "number"` falhar
   silenciosamente pra todo lembrete recém-criado — `dueDate` sempre
   voltava `null` na resposta da tool, mesmo com o valor salvo
   corretamente no EventKit (confirmado consultando de novo pela API).
   Corrigido coagindo com `Number(value)` antes de checar
   `Number.isFinite`.

Diferenças (não-bugs, só notas de implementação) que vieram junto:
buscar reminders é só assíncrono
(`fetchRemindersMatchingPredicateCompletion` — sem equivalente
síncrono de `eventsMatchingPredicate:`); vencimento é
`dueDateComponents` (ano/mês/dia/hora/minuto), não um `NSDate` como
`startDate`/`endDate` de evento — construído a partir do horário LOCAL
do instante recebido, não UTC, porque é uma data "de calendário" que
o app Reminders mostra, não um instante absoluto; identificador
estável é `calendarItemIdentifier`, não `eventIdentifier` (esse é
específico de evento); `saveReminderCommitError` e
`removeReminderCommitError` (sem o parâmetro `span` que eventos têm)
funcionaram de primeira, sem tentativa e erro.

Escopo: só título, lista (opcional, usa `defaultCalendarForNewReminders`
se omitida) e data de vencimento (opcional) — os únicos campos que a
API pública do EventKit expõe pra lembretes. Subtarefas, tags e seções
do app Reminders moderno não são suportadas (só existem via API
privada não documentada — decisão de projeto já tomada, por exigir
acesso total ao disco e ser frágil a updates do macOS); a description
de `create_reminder` instrui o agente a avisar isso em vez de simular.

## Decisões e bugs encontrados na Fase 1 (Gmail)

**Decisão: OAuth próprio, nunca o conector nativo do claude.ai.** O
ambiente onde a SARAH roda expõe, por conta própria (fora deste
projeto), um conector `claude_ai_Gmail` (`mcp__claude_ai_Gmail__*`).
Ele NÃO passa pelo Gateway de risco nem pelo audit log deste projeto
— então, mesmo sendo conveniente, quebra a garantia central da SARAH
("toda ação passa pela política central de risco, sem exceção").
Decisão: bloquear esse namespace inteiro via `disallowedTools` em
`packages/core/src/index.ts` (`"mcp__claude_ai_Gmail__*"` — confirmado
no `sdk.d.ts` do Agent SDK que specs `mcp__server__*` removem todas as
tools daquele servidor) e implementar `gmail.list_recent_emails`
própria, com OAuth do usuário (`GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`
no `.env`). Evidência real de que o conector nativo já tinha sido
usado por engano antes dessa decisão: o audit log (`data/sarah.db`)
tinha uma linha antiga com `tool_name =
mcp__claude_ai_Gmail__search_threads`, `risk: high`, `decision:
confirmed` — de uma sessão anterior a este bloqueio.

**Fluxo OAuth: loopback + PKCE, não OOB.** O fluxo
`urn:ietf:wg:oauth:2.0:oob` (colar um código manualmente) foi
desativado pelo Google em 2022; o recomendado agora pra apps
instalados é o fluxo "loopback" (RFC 8252): um servidor HTTP local
(`node:http`, porta `0` = escolhida pelo SO) recebe o redirect com o
`code`, sem precisar de servidor público nem dependência nova (PKCE
via `node:crypto`). Implementado em
`packages/gmail/src/auth-flow.ts`, rodado uma única vez (ou de novo se
o token for revogado) via `pnpm gmail:auth`
(`scripts/gmail-auth.ts`).

**Bug real de configuração (não de código) encontrado na validação:**
na primeira tentativa de autorizar, o Google devolveu **"Erro 403:
access_denied — SARAH não concluiu o processo de verificação... só
pode ser acessado por testadores aprovados"**. Causa: a tela de
consentimento OAuth do projeto no Google Cloud Console estava em modo
"Testing" (padrão pra apps novos), que só autoriza contas cadastradas
como "usuários de teste". Não dá pra contornar isso via código — é o
Google exigindo aprovação explícita da conta, por design. Resolvido
adicionando a conta do usuário em "APIs e serviços → Tela de
consentimento OAuth → Usuários de teste" no Console; depois disso,
`pnpm gmail:auth` funcionou de primeira.

**Requisito de configuração:** o client OAuth no Google Cloud Console
precisa ser do tipo **"App para computador" (Desktop app)**, não "Web
application" — só o tipo Desktop permite o redirect automático pra
qualquer porta em `http://127.0.0.1:*` sem pré-cadastrar a URI exata
(client tipo Web exigiria cadastrar a porta, que muda a cada execução,
e falharia com `redirect_uri_mismatch`). Documentado no
`.env.example`.

**DECISÃO PERMANENTE ACEITA: o app OAuth fica em modo "Testing" de
propósito — não é pendência, é escolha deliberada.** O Google exige um
processo de verificação (inclusive auditoria de segurança paga, CASA
Tier 2, pra escopos "restritos" como `gmail.readonly`) pra tirar um
app OAuth do modo "Testing" e publicá-lo "In production" sem limite de
usuários/tempo de token. Isso existe pra proteger usuários de apps de
terceiros distribuídos em massa — não se aplica ao caso de uso daqui
(um único usuário, o próprio dono do projeto, autorizando a própria
conta). Não vale o custo/esforço pra um assistente pessoal de um
usuário só, e não está no roadmap fazer isso.

**Consequência aceita, não bug:** em modo "Testing", o Google expira o
refresh token a cada ~7 dias (diferente de apps "In production", cujo
refresh token dura indefinidamente até ser revogado). Isso significa
reautorizar rodando `pnpm gmail:auth` manualmente mais ou menos uma
vez por semana — **é esperado, é do Google, não é bug deste código.**
Se `gmail.list_recent_emails` passar a falhar com a mensagem "Refresh
token do Gmail inválido, expirado ou revogado..." depois de alguns
dias sem uso, a ação certa é rodar `pnpm gmail:auth` de novo, não
investigar como se fosse regressão de código. (Nota pra quem ler isso
daqui a uns meses, inclusive eu mesmo: se esse comportamento virar
incômodo real no dia a dia, a alternativa é completar a verificação do
Google — mas isso é decisão consciente de trocar custo por
conveniência, não correção de bug.)

**Validado contra a API real do Google** (não só lido no código):
salvei um refresh token inválido no Keychain (sobrescrevendo
temporariamente o real, que foi restaurado logo em seguida) e chamei
`listRecentEmails` de verdade — o Google respondeu com `invalid_grant`
e `buildAuthError` (`packages/gmail/src/client.ts`) devolveu a
mensagem clara esperada, em vez de um erro genérico. Esse é
exatamente o formato de erro que o Google devolve tanto pra token
expirado (~7 dias em modo Testing) quanto pra token revogado
manualmente em myaccount.google.com/permissions — `invalid_grant` é o
código padrão da RFC 6749 pra "esse grant não é mais válido", cobrindo
os dois casos com a mesma mensagem já tratada.

**Armazenamento do refresh token: Keychain do macOS via `security`
CLI**, não arquivo/`.env` — mesmo padrão de "chamar um binário do
sistema via `child_process` e tratar stdout/stderr" já usado no bridge
JXA do EventKit (`packages/gmail/src/keychain.ts`). Testado
isoladamente (save/read round-trip) antes de integrar no fluxo OAuth
completo.

**Sem cache de access token** — renovado a cada chamada a partir do
refresh token. Mesma lição já registrada na seção do Notion Calendar
sobre o bug de cache do schema: uma chamada HTTP a mais é custo
desprezível, e cache é a classe de bug mais fácil de introduzir por
engano (fica "preso" no valor antigo até reiniciar o processo).

**Escopo dos dados lidos:** só `gmail.readonly` (nunca modificar/
enviar/apagar), e só metadados por e-mail (`From`/`Subject`/`Date` +
`snippet` — o preview curto que a API Gmail já inclui em qualquer
`format` exceto `raw`), não o corpo completo de cada mensagem — decisão
de minimizar o dado puxado, suficiente pra resumir e mais barato/
privado que buscar o corpo inteiro de cada e-mail.

## Status atual

Fase 0 (fundação) e Fase 1 (Apple Calendar via EventKit) implementadas
e **validadas rodando de verdade nesta máquina** — `pnpm dev` real,
não só revisão de código:

- `ping` → roda direto, sem confirmação (baixo risco).
- `pretend_delete` → pede confirmação "(s/n)" antes de rodar (alto
  risco) — testado com "s" e "n".
- `liste meus eventos de hoje` → chamou `list_events` de verdade via
  EventKit, sem pedir confirmação, e devolveu os eventos reais do
  Calendário.
- `cria um evento de teste...` → chamou `create_event` de verdade,
  sem pedir confirmação, e o evento apareceu no Calendário de
  verdade (confirmado consultando o EventKit de novo depois).
- `data/sarah.db` tem as decisões `auto-allow` das duas tools novas
  registradas na tabela `tool_calls`.

O diálogo de permissão de acesso ao Calendário do macOS não apareceu
durante a validação porque o acesso já estava concedido de uma
sessão anterior (status `EKAuthorizationStatusFullAccess`) — em uma
máquina/usuário sem esse acesso prévio, ele aparece na primeira
chamada, pedindo permissão pro processo `osascript`.

**Notion Calendar (`notion.create_event`) também validado rodando de
verdade**, com um banco de dados real do usuário, depois de corrigir
os quatro pontos acima. Os três cenários de desambiguação com
`apple_calendar.create_event` foram testados via `pnpm dev` de
verdade:

- Pedido **sem** especificar calendário ("marca um almoço com a Ana
  amanhã ao meio-dia") → só `notion.create_event` rodou (confirmado
  no audit log: uma única entrada, `auto-allow`).
- Pedido dizendo **"Apple Calendar"** explicitamente → só
  `apple_calendar.create_event` rodou.
- Pedido dizendo **"Notion"** explicitamente → só `notion.create_event`
  rodou.

Em nenhum dos três as duas tools foram chamadas juntas. As páginas e
o evento de teste criados durante essa validação foram removidos
depois (Notion: movidos pra lixeira; Apple Calendar: evento apagado)
— não é lixo deixado pra trás no calendário/Notion reais do usuário.

**Parâmetro `categoria` em `notion.create_event` também validado**,
depois do episódio de debug do bug #5 acima (schema cacheado
mascarando a propriedade recém-renomeada). `categoria` é um enum Zod
fechado (`Viagem`, `Pessoal`, `Saúde`, `Estudos`, `Trabalho` — as
mesmas opções, com as mesmas cores, já configuradas na propriedade
Select "Categoria" do banco do usuário), não texto livre — o agente
não pode inventar uma opção nova e quebrar a organização por cor.
Testado via `pnpm dev` real com "categoria Pessoal": conferido direto
pela API do Notion (não só pelo texto que o agente respondeu) que a
página criada tinha `Categoria: {select: {name: "Pessoal", color:
"yellow"}}` — bate exatamente com a opção configurada no banco.

**Apple Reminders (`apple_reminders.list_reminders` /
`apple_reminders.create_reminder`) também validado rodando de
verdade**, depois de corrigir os quatro bugs documentados acima
(crash com `null`/array literal, predicate que exclui lembrete sem
data, `NSDateComponents` devolvendo string):

- `liste meus lembretes pendentes` → trouxe os lembretes reais do
  usuário (várias listas: Compras, Trabalho, Pessoal, Casa), sem
  pedir confirmação.
- `cria um lembrete... pra amanhã às 9h` → criou de verdade, sem
  confirmação; conferido direto pelo bridge (não só pelo texto do
  agente) que `dueDate` bateu exatamente com o horário pedido
  (09h local = `2026-08-12T12:00:00.000Z`).
- `cria um lembrete... sem data de vencimento` → criou sem
  `dueDate`, também sem confirmação.
- Audit log com as três decisões `auto-allow`.

O popup de permissão de Lembretes do macOS não apareceu porque o
acesso já tinha sido concedido durante a sessão de debug isolada
(mesma situação do Calendar) — numa máquina sem esse acesso prévio,
aparece na primeira chamada. Os lembretes de teste foram removidos
depois de confirmados.

**Gmail (`gmail.list_recent_emails`) também validado rodando de
verdade**, depois de resolver o bug de configuração do Google Cloud
Console (usuário de teste) documentado acima:

- `pnpm gmail:auth` → fluxo completo no navegador (login + tela de
  consentimento), refresh token salvo no Keychain — conferido lendo
  de volta com `security find-generic-password`, não só pela mensagem
  de sucesso do script.
- `listRecentEmails` testado isolado antes de ligar na tool completa
  (mesma metodologia das fases anteriores): trouxe e-mails reais da
  caixa de entrada do usuário.
- `resuma meus e-mails de hoje` via `pnpm dev` → rodou direto, sem
  pedir confirmação; audit log confirma `tool_name =
  mcp__sarah-gmail__list_recent_emails`, `risk: low`, `decision:
  auto-allow` — não `claude_ai_Gmail`. Nenhum warning
  `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` no stderr. O resumo gerado foi
  comparado pelo usuário com a caixa de entrada real.
- Confirmado no mesmo audit log que uma chamada anterior a
  `mcp__claude_ai_Gmail__search_threads` (do conector nativo, antes do
  bloqueio) fica registrada como `risk: high`, `decision: confirmed`
  — prova de que era esse conector, não `gmail.list_recent_emails`,
  que tinha sido usado por engano antes desta implementação.

## Renomeação: JARVIS → SARAH

O projeto (e o assistente em si) foi renomeado de JARVIS pra SARAH —
troca cosmética **e** funcional, pedida explicitamente. O que mudou:

- **Nome do pacote raiz** (`package.json`): `jarvis` → `sarah`.
- **Todos os pacotes do workspace**: `@jarvis/*` → `@sarah/*` (nome em
  cada `package.json`, todas as dependências `workspace:*` entre eles,
  e todo `import ... from "@jarvis/..."` no código).
- **Nomes dos MCP servers** (`name:` passado a `createSdkMcpServer` +
  a chave correspondente em `mcpServers: {...}` no `query()` — os dois
  precisam bater, é assim que o SDK monta o nome qualificado da tool):
  `jarvis-fixtures` → `sarah-fixtures`, `jarvis-apple-calendar` →
  `sarah-apple-calendar`, `jarvis-notion` → `sarah-notion`,
  `jarvis-apple-reminders` → `sarah-apple-reminders`.
- **`LOW_RISK_TOOLS`** em `packages/permissions/src/index.ts`: as seis
  strings (`mcp__jarvis-*__*`) reescritas pra `mcp__sarah-*__*` — é
  aqui que um nome de MCP server desalinhado do resto do código vira
  bug de verdade: a tool cai no fail-safe de alto risco (não é
  perigoso, só passa a pedir confirmação à toa pra uma tool que
  deveria rodar direto).
- **`runJarvis()`** → `runSarah()` (`packages/core/src/index.ts`,
  `apps/cli/src/main.ts`), banner do terminal ("JARVIS (Fase 1)..." →
  "SARAH (Fase 1)..."), arquivo do audit log (`data/jarvis.db` →
  `data/sarah.db` — o arquivo existente foi movido, não recriado do
  zero, pra não perder o histórico de auditoria já gravado).
- **README.md e este arquivo**: título, exemplos de prompt ("Teste
  JARVIS" → "Teste SARAH") e todo texto que citava "JARVIS".

**O que ficou de propósito sem mudar:** o nome da pasta no disco desta
máquina (`jarvis/`, visível no diagrama de estrutura do repositório
acima) — isso é um caminho de sistema de arquivos, não faz parte do
nome do projeto/produto, e renomear a pasta é uma operação de
infraestrutura à parte (moveria o working directory, poderia mexer com
estado de IDE etc.) que não foi pedida.

**Revalidado rodando de verdade** (`pnpm dev`, depois de `pnpm install`
pra relinkar o workspace com os nomes novos) — as quatro tools de
baixo risco testadas de novo, nenhuma voltou a pedir confirmação à
toa (o que teria indicado um nome de MCP server desalinhado):

- `ping` → direto, sem confirmação.
- `cria no Apple Calendar...` → direto, sem confirmação; audit log:
  `mcp__sarah-apple-calendar__create_event`, `auto-allow`.
- `cria no Notion...` → direto, sem confirmação; audit log:
  `mcp__sarah-notion__create_event`, `auto-allow`.
- `cria um lembrete...` → direto, sem confirmação; audit log:
  `mcp__sarah-apple-reminders__create_reminder`, `auto-allow`.

Conferido lendo o `tool_name` de cada linha no `data/sarah.db` (não só
o texto do agente) — os quatro batem exatamente com os nomes `sarah-*`
novos. Os eventos/página/lembrete de teste criados durante essa
revalidação foram removidos depois.

## Roadmap completo (pra não perder o fio)

0. Fundação — monorepo, Agent SDK, Gateway, audit log. **(feito)**
1. MVP — Apple Calendar (**feito**: list_events + create_event) +
   Notion Calendar (**feito**: create_event, calendário principal) +
   Apple Reminders (**feito**: list_reminders + create_reminder) +
   Gmail (**feito**: list_recent_emails, leitura, OAuth próprio),
   interface terminal. **(Fase 1 completa)**
2. Memória estruturada + preferências.
3. Apple Notes + ações de e-mail (responder/rascunho) com confirmação.
4. App de menu bar nativo substituindo o terminal; voz opcional.
5. Agente de código: sandbox Docker por projeto, criação de projetos, git.
6. GitHub completo (commits, PRs) + deploy de sites.
7. Memória semântica (embeddings via Voyage AI) + observabilidade +
   nuance no risco médio.
8. Novas integrações e expansões.

## Próximo passo concreto

**Fase 1 está completa**: Apple Calendar, Notion Calendar, Apple
Reminders e Gmail (leitura) feitos e validados rodando de verdade,
cada um com sua tool passando pelo mesmo Gateway de risco e audit log
— inclusive o conector nativo de Gmail do ambiente, que fica bloqueado
de propósito em vez de ser usado por atalho. Próximo passo é a Fase 2:
memória estruturada + preferências do usuário.
