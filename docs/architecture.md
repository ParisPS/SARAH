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
  apps/menubar/          # Fase 4: interface Electron (Tray + janela), roda ao lado do cli
  packages/
    core/                 # orquestrador: chama query() do Agent SDK
    permissions/           # Gateway: classifyRisk() + canUseTool
    audit/                  # log de decisões em SQLite
    fixtures/                # tools de teste (ping / pretend_delete)
    apple-calendar/           # Fase 1: Apple Calendar via EventKit (ponte JXA)
    notion/                   # Fase 1: Notion Calendar (API REST oficial, sem SDK)
    apple-reminders/          # Fase 1: Apple Reminders via EventKit (ponte JXA)
    gmail/                     # Fase 1: Gmail (leitura, OAuth próprio) — fecha a Fase 1
    memory/                     # Fase 2: memória persistente (fatos + preferências, SQLite+FTS5)
    apple-notes/                 # Fase 3: Apple Notes via scripting Application("Notes") (não EventKit)
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

## Decisões e bugs encontrados na Fase 2 (Memória)

**Correção de registro, antes de mais nada:** numa resposta anterior
desta mesma conversa, afirmei que memória de sessão (conversa
continuando entre turnos dentro da MESMA execução do `pnpm dev`) já
tinha sido resolvida numa correção pós-Fase-1. **Isso era falso** — não
existia essa correção em lugar nenhum (nem no código, nem documentada
aqui antes desta seção). Conferindo `packages/core/src/index.ts` de
verdade, cada prompt do REPL chamava `query()` do zero, sem `resume`
nem `sessionId` — ou seja, cada linha digitada era uma conversa
completamente nova pro Agent SDK, mesmo dentro do mesmo processo. Essa
seção documenta a correção de verdade, feita agora.

### Duas memórias diferentes, dois mecanismos diferentes

Este projeto agora tem DOIS conceitos de "memória" que não devem ser
confundidos:

1. **Memória de SESSÃO** (`resume` do Agent SDK) — o histórico da
   conversa atual continua entre prompts, mas só enquanto o processo
   `pnpm dev` está rodando. Reinicia o processo, perde tudo. Serve pra
   "esse mesmo evento", "e sobre isso que eu falei antes" etc.
2. **Memória PERSISTENTE** (`@sarah/memory`, esta fase) — fatos e
   preferências guardados em SQLite, sobrevivem a reiniciar o processo
   indefinidamente. Serve pra "sempre faça X" e "o que você sabe sobre
   mim?".

### Memória de sessão: captura de `session_id` + `resume`

Confirmado na definição de tipos do SDK instalado (`sdk.d.ts`, não por
memória de versões antigas, como pedido): a mensagem `system`/`init` —
a primeira mensagem de todo stream de `query()` — carrega
`session_id: string`; a opção `resume?: string` em `query({ options:
{...} })` carrega o histórico de uma sessão anterior. Implementado em
`packages/core/src/index.ts`: uma variável `sessionId` no escopo do
loop principal é atualizada a cada mensagem `system`/`init` recebida
(não só na primeira — auto-corretivo caso uma chamada futura force
fork de sessão) e passada como `resume` em toda chamada seguinte a
`query()`. Reseta sozinho ao reiniciar o processo (`sessionId` volta a
ser `undefined`) — isso é o esperado, não um bug: memória de sessão
não é memória persistente.

### Memória persistente: schema

`packages/memory`, SQLite próprio em `data/sarah-memory.db` (mesmo
padrão de um arquivo por responsabilidade que `@sarah/audit` já usa).
Tabela única `memories` (`id`, `content`, `category`, `created_at`) —
`category` é um enum Zod fechado (`"fato" | "preferencia"`), não texto
livre, mesmo motivo do `categoria` do Notion Calendar: o core precisa
filtrar `category === "preferencia"` de forma confiável (ver injeção
determinística abaixo); um valor livre digitado errado quebraria esse
filtro silenciosamente.

Busca por palavra-chave via `memories_fts`, uma virtual table **FTS5**
no modo *external content* (`content='memories', content_rowid='id'`)
— o texto de verdade mora só em `memories.content`, a FTS5 guarda só o
índice invertido, sincronizado por TRIGGER em INSERT **e DELETE**
(não só INSERT): testado isoladamente antes de escrever qualquer
código — sem o trigger de DELETE, `memory.forget` apagaria a linha de
`memories` mas deixaria um registro fantasma pesquisável na FTS pra
sempre. Confirmado nos dois sentidos: com o trigger, uma busca por um
termo de uma memória apagada devolve zero resultados E a FTS não fica
com nenhuma linha órfã (`SELECT rowid FROM memories_fts` bate exato
com o que sobrou em `memories`).

`memory.recall(query?)`: a query em linguagem natural do usuário é
convertida numa expressão FTS5 segura — cada token vira uma frase
entre aspas, unidos por `OR` (`toFtsQuery()` em
`packages/memory/src/db.ts`). Evita dois problemas reais testados
isoladamente: sintaxe FTS5 quebrando com palavras reservadas do
próprio FTS5 (`AND`/`OR`/`NOT`) ou pontuação, e — mais importante —
`query` é **opcional**: sem ela (ou só pontuação), a busca cai pra
"as memórias mais recentes" em vez de tentar casar palavra-chave.
Necessário porque testado isoladamente que um MATCH FTS5 com os tokens
de uma pergunta genérica tipo "o que você sabe sobre mim?" não bate
com nada guardado — não existe termo específico pra buscar nesse caso,
então a busca por palavra-chave sozinha não cobriria esse uso.

### Tools e risco

- `memory.remember(content, category)` — baixo risco (aditivo, nunca
  sobrescreve/apaga).
- `memory.recall(query?, limit?)` — baixo risco (leitura pura).
- `memory.forget(id)` — **alto risco** (exclusão permanente), de
  propósito fora de `LOW_RISK_TOOLS`: cai no fail-safe, pede
  confirmação, igual qualquer ação destrutiva deste projeto.

Diferente dos outros pacotes de tool (que exportam um `xServer`
pronto), `packages/memory` exporta uma FACTORY
(`createMemoryServer(dbPath)`), porque `packages/core/src/index.ts`
precisa de acesso direto ao `MemoryStore` por trás das tools — não só
pra chamar via MCP, mas pra ler `category === "preferencia"` ele mesmo
antes de cada `query()` (ver abaixo). Um único `MemoryStore` (uma
única conexão SQLite) é compartilhado entre as tools e essa leitura
direta do core.

### Injeção determinística de preferências — o porquê de não depender só de `memory.recall`

Uma preferência guardada precisa influenciar o comportamento de
OUTRAS tools automaticamente (ex.: lista padrão de lembretes),
sozinha, sem o usuário repetir. Depender do agente **decidir** chamar
`memory.recall` antes de cada ação não seria confiável — é uma decisão
que ele teria que acertar de novo em toda conversa nova, pra toda tool
que pudesse ter uma preferência relevante, sem nenhuma garantia.

Solução: `packages/core/src/index.ts` chama
`memoryStore.listByCategory("preferencia")` **sem cache** (busca
fresca antes de cada `query()` — mesma lição já registrada aqui sobre
o bug de cache do schema do Notion) e injeta o resultado via
`systemPrompt`. Formato exato confirmado na definição de tipos do SDK
instalado antes de escrever qualquer código (não assumido de exemplo
antigo):

```ts
systemPrompt: {
  type: "preset",
  preset: "claude_code",
  append: "Preferências conhecidas do usuário — aplique automaticamente...\n- <preferência 1>\n- ...",
}
```

Isso preserva o system prompt padrão do Claude Code (`preset:
"claude_code"`) e só ACRESCENTA as preferências — chega pro modelo
garantido em toda chamada, não como uma tool que ele pode esquecer de
chamar. `memory.recall` continua existindo como tool, pra busca sob
demanda (ex.: "o que você sabe sobre mim?", que também cobre fatos,
não só preferências).

### Achado lateral: `AskUserQuestion` do próprio agente também é alto risco

Durante a validação, o agente às vezes usa sua PRÓPRIA tool
`AskUserQuestion` (nativa do Agent SDK) pra pedir esclarecimento antes
de um `forget` ambíguo (ex.: duas memórias de teste idênticas). Como
`AskUserQuestion` não está em `LOW_RISK_TOOLS`, ela cai no mesmo
fail-safe de alto risco e também pede confirmação `(s/n)` no terminal
— efeito colateral correto do design (pior caso é confirmação a mais,
nunca execução silenciosa), mas vale de saber: uma pergunta de
esclarecimento do próprio agente também para o fluxo esperando "s/n".

### Notas pendentes da Fase 2 (sem ação de código agora — só registro pro futuro)

**As duas notas abaixo foram RESOLVIDAS na Fase 7, parte 1 (memória
semântica) — mantidas aqui, sem editar o texto original, como registro
histórico de como o problema foi enxergado na época; ver a seção
"Decisões e bugs encontrados na Fase 7, parte 1" mais abaixo pra como
cada uma foi resolvida de verdade.**

1. **`listByCategory("preferencia")` não tem limite** — toda a tabela
   de preferências entra inteira no `systemPrompt` de cada `query()`.
   Sem custo perceptível hoje (poucas preferências, um assistente
   pessoal de um usuário só), mas cresce sem revisão: se um dia isso
   virar uma lista longa, cada chamada ao modelo carrega esse texto
   inteiro de novo, sempre. Não implementado agora (paginação, resumo,
   ou algum critério de relevância/recência) porque seria
   over-engineering pra um problema que ainda não existe — só
   registrado aqui pra não ser esquecido quando existir.
2. **Não há tratamento de preferência duplicada ou conflitante.** Se o
   usuário guardar duas preferências que se contradizem (ex.: "sempre
   lista Trabalho" e depois "sempre lista Pessoal"), as DUAS entram no
   `systemPrompt` — o comportamento resultante depende de como o
   modelo interpreta a contradição, não é determinístico por design.
   `memory.forget` existe como saída, mas depende do usuário lembrar
   de apagar a preferência antiga antes de guardar uma nova — nada
   detecta ou avisa sobre o conflito automaticamente. Não resolvido
   agora (ex.: versionar preferências, substituir por categoria+chave
   em vez de só categoria) pela mesma razão do item 1: ainda não virou
   problema real, e a complexidade extra (o que conta como "a mesma"
   preferência? por texto? por similaridade?) não vale a pena
   antecipar sem um caso real guiando a decisão.

## Decisões e bugs encontrados na Fase 3 (Apple Notes)

**Mecanismo diferente de propósito, não EventKit.** Notes.app não tem
framework público equivalente ao EventKit usado por apple-calendar/
apple-reminders — só scripting via `Application("Notes")` (o
dicionário AppleScript do app, exposto em JXA). Sem `ObjC.import`, sem
`EKEventStore`, sem `requestAccess` explícito: outro mecanismo do
macOS inteiramente (Apple Events/Automation). Por isso os bugs
encontrados aqui são NOVOS, específicos deste bridge — testado contra
o app real antes de qualquer linha de código, mesma metodologia de
sempre, sem assumir que as armadilhas do EventKit se repetiriam:

1. **Título e primeira linha do `body` são a MESMA COISA** — não dois
   campos independentes como em Reminders (title vs body/notes). Ao
   criar `Notes.Note({name, body})`, o Notes.app insere `name`
   AUTOMATICAMENTE como a primeira linha do body, mesmo que o body
   passado não a contenha (testado: um body com conteúdo diferente na
   "primeira posição" ainda ganha o título como linha 1, empurrando o
   resto). Por isso o bridge nunca inclui o título dentro do `body`
   que monta, e a leitura remove a primeira linha de `plaintext()`
   pra devolver "conteúdo" sem repetir o título.
2. **`body` é interpretado como HTML de verdade**, não texto puro —
   testado passando `<tag>` e `&`/aspas sem escapar: a tag some
   (marcação inválida descartada) e os caracteres especiais corrompem
   o HTML armazenado. Corrigido escapando todo conteúdo do usuário
   (`&`, `<`, `>`, `"`, `'`) antes de montar o body.
3. **Quebra de linha real (`\n`) dentro da string do body NÃO cria
   parágrafos separados** — testado: todas as linhas colapsam numa
   linha só, separadas por espaço. Corrigido convertendo pra `<br>`
   explicitamente, depois de escapar (senão o `<br>` também seria
   escapado e apareceria como texto literal).
4. **`account.notes()` sem filtro de pasta inclui as notas da pasta
   "Recently Deleted"** (lixeira) — testado: uma lista geral de notas
   trazia itens já apagados junto. Não faz sentido pra um "liste
   minhas notas" comum, então o bridge filtra essa pasta por nome ao
   listar sem `folderName` explícito (limitação conhecida: só
   funciona no idioma em que essa pasta aparece pro usuário — testado
   em "Recently Deleted", inglês; não filtra nada se o usuário pedir
   essa pasta explicitamente por nome).
5. **Pasta não encontrada lança um erro JS capturável**
   (`Can't get object.`), diferente do crash nativo incapturável do
   EventKit ao passar `null`/array literal em certos parâmetros (bug
   documentado na Fase 1 do apple-reminders) — um `try/catch` normal
   já resolve aqui, sem precisar de nenhum tratamento especial.
6. **Pasta padrão não é hardcoded** ("Notes"/"Notas" conforme idioma
   do sistema): criar/listar sem especificar pasta usa
   `account.notes`/`account.notes.push(...)` diretamente, sem
   precisar adivinhar o nome localizado da pasta padrão.

Escopo: só título, conteúdo em texto simples (opcional) e pasta
(opcional) — mesmo princípio do apple-reminders (só o que a interface
de scripting cobre com confiança). Sem anexos, sem formatação rica,
sem tags.

## Decisões e bugs encontrados na Fase 3, parte 2 (ações de e-mail: Gmail)

**Correção da premissa inicial, confirmada na documentação oficial da
API antes de escrever qualquer código** (não assumida): o pedido
original considerava trocar o escopo OAuth de `gmail.readonly` pra
`gmail.compose`. Isso quebraria a leitura — `gmail.compose` sozinho
NÃO permite ler mensagens. Conferido na referência oficial de cada
método (`developers.google.com/workspace/gmail/api/reference/rest/v1`):

- `users.messages.get` (usado por `get_message`, e internamente por
  `reply_draft` pra montar a resposta) exige um destes escopos:
  `https://mail.google.com/`, `gmail.modify`, `gmail.readonly` ou
  `gmail.metadata` — `gmail.compose` não está nessa lista.
- `users.drafts.create`/`users.drafts.update` (usado por
  `create_draft`/`reply_draft`) exigem `https://mail.google.com/`,
  `gmail.modify` ou `gmail.compose`.

Ou seja: os dois escopos são necessários **juntos**, não um no lugar
do outro. `auth-flow.ts` agora pede
`gmail.readonly gmail.compose` (espaço-separado, um único parâmetro
`scope`) — reautorizado rodando `pnpm gmail:auth` de novo (o refresh
token anterior só tinha `readonly`, precisou gerar um novo).

**LIMITAÇÃO ACEITA, documentada aqui de propósito (mesmo padrão das
outras decisões já registradas — modo Testing do Gmail, sem cache de
schema do Notion etc.): `gmail.compose` também permite ENVIAR
e-mail/rascunho do lado da API do Google — não existe um escopo OAuth
mais restrito, só-rascunho, nessa API.** A garantia de "a SARAH nunca
envia e-mail" não vem da permissão OAuth (ela tecnicamente permitiria);
vem do CÓDIGO: `packages/gmail/src/client.ts` só chama
`POST /drafts` (criar rascunho), nunca `POST
/messages/send` ou `POST /drafts/{id}/send` — esses dois endpoints não
aparecem em nenhum lugar deste pacote, de propósito, e não há
`gmail.send_*` nem qualquer tool de enviar registrada (decisão de
projeto desde a primeira mensagem). Isso é diferente de todas as
outras tools deste projeto, cujo baixo risco é reforçado tanto pelo
código quanto pelo escopo de acesso concedido — aqui o escopo é mais
amplo que o necessário, e a única barreira real é não ter escrito
(nem nunca escrever) o código que chamaria enviar.

**Mecânica de montar/ler e-mail (RFC 2822 cru), tudo novo nesta fase:**

- A API do Gmail espera o e-mail inteiro (cabeçalhos + corpo) como uma
  string RFC 2822 crua, codificada em base64url, no campo `raw` de
  `POST /drafts`. Corpo sempre em `Content-Transfer-Encoding: base64`
  (não texto "cru" no meio dos cabeçalhos) — evita qualquer ambiguidade
  com bytes UTF-8 (acentos) trafegando fora de um encoding declarado
  explicitamente.
- `Subject` sempre codificado em RFC 2047 (`=?UTF-8?B?...?=`) — mais
  simples que detectar "tem acento ou não" e tratar os dois casos
  separado; decodifica igual num cliente de e-mail compatível mesmo
  quando o texto é só ASCII.
- **`reply_draft` busca só os headers do e-mail original**
  (`format=metadata`, não `format=full`) — não precisa do corpo pra
  montar a resposta, só `Subject` (pra prefixar "Re:" — sem duplicar
  se já tiver), `From` (vira o `To` da resposta), `Message-ID` e
  `References` (pra virar `In-Reply-To`/`References` da resposta,
  fazendo aparecer encadeada na thread de verdade, não como e-mail
  solto) e o `threadId` do Gmail (sempre presente independente do
  `format`). Mesmo princípio de minimizar dado puxado já registrado na
  Fase 1.
- `get_message` (corpo completo, sob demanda) extrai a parte
  `text/plain` do payload MIME (que pode ser multipart, busca em
  profundidade recursiva); se o e-mail só tiver `text/html` (alguns
  têm), faz uma conversão HTML→texto BEM simples como fallback (troca
  `<br>`/`</p>`/`</div>` por quebra de linha, remove o resto das tags,
  decodifica só as entidades HTML mais comuns) — não tenta preservar
  formatação, só extrair texto legível, mesmo princípio "texto
  simples" do resto do projeto.

**Validado rodando de verdade, incluindo inspeção direta pela API do
Gmail** (não só pelo texto do agente nem pelo app Gmail visualmente —
os headers e o `labelIds` do rascunho foram conferidos programaticamente):

- `abre o e-mail da Mottu sobre o Trainee 2026.2 e cria um rascunho de
  resposta agradecendo...` → chamou `get_message` (leu o corpo real do
  e-mail original) e depois `reply_draft`, sem pedir confirmação (baixo
  risco). Audit log confirma as duas chamadas, `risk: low`, `decision:
  auto-allow`.
- Rascunho conferido direto pela API do Gmail (`GET /drafts`,
  `GET /drafts/{id}?format=full`): `labelIds: ["DRAFT"]` (nunca
  `SENT`), `Subject: "Re: Confirmação de Inscrição..."` (um só "Re:",
  sem duplicar), `In-Reply-To`/`References` apontando pro
  `Message-ID` certo do e-mail original, `threadId` do rascunho igual
  ao `id` do e-mail original (confirma que ficou na mesma thread), e o
  corpo decodificado batendo exatamente com o texto pedido, acentos
  preservados.
- `create_draft` (sem thread) testado separado: mesma verificação —
  `labelIds: ["DRAFT"]`, sem `In-Reply-To`/`References` (correto, não
  é resposta a nada).
- Os dois rascunhos de teste foram apagados depois (`DELETE
  /drafts/{id}`, confirmado `resultSizeEstimate: 0` na lista depois).

## Decisões e bugs encontrados na Fase 3, parte 3 (envio de e-mail: `send_draft`)

**Não é reversão da decisão de "nunca implementar tool de enviar" —
é essa decisão deliberada acontecendo.** Até aqui (partes 1 e 2 desta
fase), a regra era "só leitura e rascunho, nunca enviar", registrada
como decisão permanente desde a primeira mensagem do projeto. O
usuário decidiu, de propósito e explicitamente, autorizar o envio
agora — com uma restrição que continua valendo, mais importante do
que nunca: **NUNCA existe (nem vai existir) uma tool de "compor e
enviar direto"**. `send_draft(draftId)` só envia um rascunho que JÁ
EXISTE, criado antes por `create_draft`/`reply_draft` — o fluxo sempre
passa por rascunho primeiro, sem exceção.

**Escopo: confirmado na documentação oficial ANTES de implementar, não
assumido a partir da fase anterior** (o usuário pediu explicitamente
essa checagem, porque a decisão anterior podia ter sido imprecisa).
`users.drafts.send` aceita `https://mail.google.com/`, `gmail.modify`
ou `gmail.compose` — o escopo `gmail.compose` já autorizado na parte 2
desta fase já cobre enviar, **não precisou reautorizar**. Isso
confirma (agora com certeza, verificado no endpoint exato que importa,
não só na descrição geral do escopo) a limitação já registrada: não
existe no Gmail um escopo OAuth que permita só rascunho e não envio —
a garantia de "nunca enviava" nas partes 1/2 desta fase era inteiramente
do código, nunca da permissão concedida.

**Risco: ALTO, fora de `LOW_RISK_TOOLS`** — primeira ação
verdadeiramente irreversível de e-mail do projeto. Diferente de criar
rascunho (reversível: só apagar o rascunho), um e-mail enviado não
pode ser desenviado.

**Melhoria na confirmação, só pra esta tool**: o Gateway
(`@sarah/permissions`) ganhou um `formatConfirmationInput` opcional —
uma função injetada que pode substituir o `Entrada: {JSON cru}` padrão
por um texto melhor formatado, específico da tool. `@sarah/permissions`
continua sem depender de nenhum pacote de tool (não importa
`@sarah/gmail` nem sabe que ele existe) — só chama a função que
`packages/core/src/index.ts` injeta, que aí sim conhece
`getDraftPreview` do `@sarah/gmail` (busca o rascunho pela API antes
de perguntar `(s/n)`, mostra Para/Assunto/corpo — corpo truncado em
500 caracteres se for longo, é só um preview pra decisão, não o
conteúdo completo). Falha ao buscar o preview (ex.: rascunho já foi
apagado nesse meio-tempo) cai pro fallback padrão em vez de travar a
confirmação.

**Validado rodando de verdade, com inspeção direta pela API do Gmail
(não só o texto do agente):**

- Criei um rascunho de teste **pra mim mesmo**
  (`paris.perez.s@gmail.com`, nunca pra terceiros), depois pedi
  `envia o rascunho <id>`.
- A tela de confirmação mostrou exatamente o formato pedido, não o
  JSON cru:
  ```
  ⚠️  Ação de ALTO RISCO solicitada: mcp__sarah-gmail__send_draft
     Rascunho a enviar:
     Para: paris.perez.s@gmail.com
     Assunto: Teste SARAH send_draft
     Corpo: Validação real do envio na Fase 3 — se isso chegou na sua caixa de entrada, o send_draft funcionou. Pode apagar.
     Confirmar execução? (s/n)
  ```
- Respondi "s" → confirmado no audit log: `mcp__sarah-gmail__send_draft`,
  `risk: high`, `decision: confirmed` (diferente de todo o resto da
  Fase 3, que é `risk: low`/`auto-allow`).
- Conferido DIRETO pela API do Gmail (`GET /messages/{id}`, não só a
  resposta do agente nem o app Gmail visualmente): `labelIds:
  ["SENT", "INBOX"]` — realmente saiu e chegou na caixa de entrada
  (era pra mim mesmo), headers `To`/`Subject`/`From` corretos.
- **Limpeza incompleta, e isso é informativo**: tentei mover o e-mail
  de teste pra lixeira via API (`messages.trash`) depois de confirmar
  o teste, e recebi `403` — esse endpoint exige `gmail.modify` ou
  `https://mail.google.com/`, escopos que este projeto não tem (nem
  pediu). Não vale a pena pedir um escopo mais amplo só por
  conveniência de limpar um teste — reforça, na prática, que o escopo
  concedido continua sendo exatamente o mínimo necessário pras quatro
  tools de e-mail que existem (ler, rascunhar, responder, enviar
  rascunho), nem um pouco mais. O e-mail de teste ("Teste SARAH
  send_draft") ficou na caixa de entrada do usuário, marcado no
  próprio corpo como descartável — removido manualmente por ele depois.

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

**Memória (Fase 2) validada rodando de verdade, em DUAS execuções
separadas do `pnpm dev`** (não a mesma sessão — o que importava aqui
era sobreviver a reiniciar o processo, não conversa continuando):

- **Execução 1**: `lembra que eu sempre quero que lembretes sejam
  criados na lista Trabalho por padrão` → guardado com `category:
  "preferencia"`, conferido direto no `data/sarah-memory.db` (não só
  pelo texto do agente). Processo encerrado.
- **Execução 2** (processo novo): `cria um lembrete pra revisar o
  relatório`, sem mencionar lista nenhuma → usou **"Trabalho" sozinho**
  — conferido direto no EventKit (`list_reminders` na lista Trabalho)
  que o lembrete "Revisar o relatório" realmente foi criado lá. Prova
  que a injeção determinística via `systemPrompt` funciona entre
  processos diferentes, não só dentro do mesmo.
- `o que você sabe sobre mim?` → recuperou a preferência guardada
  (via `memory.recall` sem `query`, que lista as mais recentes) e
  distinguiu corretamente memória de longo prazo (da tool) de contexto
  do projeto atual (do `CLAUDE.md`).
- `memory.forget` testado com uma memória de teste: pediu confirmação
  `(s/n)` — audit log confirma `mcp__sarah-memory__forget`, `risk:
  high`, `decision: confirmed` — e a memória sumiu tanto de `memories`
  quanto de `memories_fts` depois (conferido direto no SQLite, sem
  linha fantasma).
- **`resume` (memória de sessão) testado na MESMA execução**: `cria um
  evento chamado "Teste Resume SARAH" amanhã às 11h` (foi pro Notion,
  padrão) e, numa mensagem SEPARADA no mesmo processo, `adiciona esse
  mesmo evento no Apple Calendar também, sem eu repetir os detalhes` —
  funcionou: usou o mesmo título e mesmo horário sem eu repetir nada,
  criando também no Apple Calendar. Conferido direto no EventKit (não
  só pelo texto do agente) que o evento apareceu lá com os detalhes
  certos. Todos os artefatos de teste desta validação (evento no Apple
  Calendar, página no Notion, lembrete "Revisar o relatório") foram
  removidos depois — a preferência sobre lembretes ficou guardada de
  propósito, é o resultado real da feature, não lixo de teste.

**Apple Notes (`apple_notes.list_notes` / `apple_notes.create_note`)
também validado rodando de verdade**, depois de corrigir os 4 bugs
reais documentados acima (título/primeira linha, HTML não escapado,
quebra de linha, pasta "Recently Deleted" vazando na listagem):

- `lista minhas notas` → rodou direto, sem confirmação; trouxe as
  notas reais do usuário (ESOGASTRO, Austrália, Ideias de nomes,
  Sabores de pizza, Lista de compras — pasta padrão "Notes"), sem
  nenhuma nota da lixeira misturada.
- `cria uma nota chamada "Teste SARAH Notes" com o conteúdo "..."` →
  rodou direto, sem confirmação; conferido direto no app Notes de
  verdade (via o bridge, não só pelo texto do agente) que a nota
  apareceu com título e conteúdo corretos, sem duplicar o título
  dentro do conteúdo.
- Audit log confirma `mcp__sarah-apple-notes__list_notes` e
  `mcp__sarah-apple-notes__create_note`, `risk: low`, `decision:
  auto-allow`.
- Nenhum popup de permissão de Automation apareceu durante a
  validação — provavelmente já concedido de sessões anteriores deste
  mesmo usuário/máquina; numa máquina sem esse acesso prévio, o macOS
  deve pedir permissão pro `osascript` controlar o Notes.app na
  primeira chamada (mesmo tipo de interação manual já visto com
  Calendar/Reminders, só que é a categoria "Automation" das
  Preferências do Sistema, não "Acesso a dados" — EventKit e Notes
  scripting usam mecanismos de permissão diferentes do macOS).
- Todas as notas de teste criadas durante a exploração e validação
  desta fase (8 no total, incluindo as usadas só pra descobrir os
  bugs acima) foram removidas depois — confirmado que sumiram da
  pasta "Notes" numa listagem final.

**`send_draft` (envio real de e-mail, decisão deliberada) também
validado rodando de verdade**, com inspeção direta pela API do Gmail
em cada etapa (não só texto do agente nem o app Gmail visualmente):

- Rascunho de teste criado pra mim mesmo, `envia o rascunho <id>` →
  tela de confirmação mostrou Para/Assunto/corpo de forma legível
  (não o `draftId` cru em JSON) — a melhoria de `formatConfirmationInput`
  funcionando como esperado.
- Confirmado com "s" → audit log: `mcp__sarah-gmail__send_draft`,
  `risk: high`, `decision: confirmed` (a primeira entrada de alto
  risco confirmado em e-mail neste projeto).
- Conferido direto na API (`GET /messages/{id}`): `labelIds: ["SENT",
  "INBOX"]` — realmente enviado, chegou na caixa de entrada.
- Limpeza automática não foi possível (`messages.trash` exige escopo
  que este projeto não tem, `gmail.modify`) — ver detalhes e a
  justificativa de não pedir esse escopo na seção acima. E-mail de
  teste removido manualmente pelo usuário.

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

## Decisões e bugs encontrados na Fase 4, parte 1 (framework de interface + Gateway desacoplado do terminal)

**Escopo desta parte:** só a escolha do framework de interface + a
refatoração do Gateway pra não depender mais de terminal. A janela/app
de menu bar em si (a Fase 4 de verdade) é o próximo passo — aqui só se
garante que o terreno está pronto pra construir em cima sem rework.

### Decisão de framework: Electron, não Tauri

Motivo, direto do histórico real deste projeto: na Fase 1,
`swiftc` falhou nesta máquina com `xcrun: error: invalid active
developer path (/Library/Developer/CommandLineTools), missing xcrun`
— Xcode Command Line Tools instalado mas incompleto, sem `Xcode.app`.
Reconferido antes de decidir o framework da Fase 4 (não assumido que
"já foi resolvido sozinho"): **o mesmo erro ainda ocorre hoje**,
`xcrun`/`xcodebuild`/`swiftc` continuam quebrados nesta máquina.

Tauri exige `cargo build` do binário principal em Rust, que por sua
vez invoca o linker/`cc` do sistema — o MESMO toolchain quebrado que
derrubou o `swiftc` na Fase 1 (não é um problema específico do
Swift, é o Xcode Command Line Tools inteiro faltando `xcrun`).
Electron, ao contrário, não precisa compilar nada localmente pro
básico (Tray + janela): o processo principal roda em Node puro e o
runtime (Chromium + Node embutidos) vem como um binário PRÉ-COMPILADO
baixado do npm — o único requisito é rede pra baixar esse binário, não
um compilador funcionando nesta máquina. Escolhido por esse motivo
específico, não por preferência genérica de ecossistema.

### Teste isolado ANTES de instalar o projeto inteiro

Seguindo a mesma metodologia de sempre (testar a peça arriscada
isolada antes de integrar): um projeto `npm` mínimo fora do monorepo
(scratchpad da sessão, descartado depois — nunca fez parte do
histórico deste repo), só com `electron` como dependência, um
`main.js` de ~15 linhas criando um `Tray` (ícone PNG mínimo embutido
como base64, só pra ter algo visível) e uma `BrowserWindow` com
"hello world".

- `npm install electron` baixou o binário pré-compilado
  (`node_modules/electron/dist/Electron.app`, confirmado com `file`:
  `Mach-O 64-bit executable arm64`) sem invocar `swiftc`/`cargo`/
  nenhum compilador — só download.
- Rodando o app: os quatro processos esperados de uma app Electron
  real subiram (main, GPU process, renderer, utility de rede),
  confirmado via `ps aux`, sem nenhum erro relacionado a compilação
  nativa ou sandbox do sistema.
- **Achado real do ambiente, não do framework:** a primeira tentativa
  falhou com `TypeError: Cannot read properties of undefined (reading
  'whenReady')` — `require("electron")` devolvia uma STRING (o
  caminho do binário), não o módulo de verdade. Causa: a variável de
  ambiente `ELECTRON_RUN_AS_NODE=1` já vem definida no shell deste
  ambiente de execução (não é nada deste projeto — provavelmente
  ligada à própria ferramenta que roda o Claude Code aqui, que também
  é Electron por baixo). Com essa variável setada, QUALQUER binário
  Electron invocado roda só como Node puro, nunca como app GUI —
  documentado aqui porque é uma armadilha real que vai se repetir se
  algum dia `pnpm dev` do app de menu bar for lançado a partir de um
  terminal/processo que herdou essa mesma variável. Contornado no
  teste com `env -u ELECTRON_RUN_AS_NODE electron .`; a app real da
  Fase 4 (próximo passo) precisa considerar isso no script que a
  lança.
- Não foi possível confirmar visualmente o Tray/janela por screenshot
  (`screencapture` falhou com "could not create image from display" —
  falta de permissão de Gravação de Tela do macOS pro processo que
  rodou o comando, uma parede de PERMISSÃO, não de compilação).
  Aceito como limitação desta validação específica — a evidência de
  processo (main/GPU/renderer/network subindo sem erro, mesmo
  mecanismo que uma janela de verdade usa) já é suficiente pra decidir
  "builda e roda nesta máquina", que era a pergunta que este teste
  respondia.

**Conclusão: nenhuma parede de compilação nativa apareceu com
Electron** — decisão confirmada, sem precisar de `xcode-select
--install` nem qualquer instalação gráfica.

### Refatoração do Gateway: confirmação deixa de assumir terminal

Antes desta fase, `@sarah/permissions` tinha `readline` (e o texto da
pergunta "(s/n)") HARDCODED dentro de `askConfirmation()` — funcionava
porque até aqui só existia uma interface (o terminal), mas não teria
como uma janela Electron confirmar uma ação de alto risco com um
dialog nativo sem reescrever esse pacote inteiro.

Mudança: `createGateway()` agora recebe `confirm: ConfirmFn`
OBRIGATÓRIO nas opções — `(toolName, input, preview) => Promise<boolean>`,
onde `preview` é o texto já resolvido por `formatConfirmationInput`
(ou `null`). `@sarah/permissions` não sabe mais nada sobre `readline`,
nem sobre qual interface está do outro lado — só chama a função que
recebeu. `packages/core`'s `runSarah()` também passou a receber
`confirm` como parâmetro obrigatório e só repassa pro Gateway, sem
tocar na lógica. `apps/cli/src/main.ts` ganhou a implementação
`confirmViaTerminal` — exatamente o mesmo `readline.createInterface` +
texto + `(s/n)` que existia antes dentro de `@sarah/permissions`, só
que movido pra cá. Uma futura `apps/menubar` (Fase 4 de verdade) vai
fornecer sua própria implementação (dialog nativo do Electron) sem
precisar tocar em `@sarah/permissions` nem em `@sarah/core`.

**Validado rodando de verdade, comparando com o comportamento de ANTES
da refatoração** (mesmo texto, mesmo fluxo — não só "não quebrou"):

- `me dê um ping...` → roda direto, sem confirmação (baixo risco,
  auto-allow) — comportamento inalterado.
- `finja apagar o arquivo teste.txt` → tela de confirmação idêntica à
  de antes: `⚠️  Ação de ALTO RISCO solicitada: mcp__sarah-fixtures__pretend_delete`,
  `Entrada: {"path":"teste.txt"}`, `Confirmar execução? (s/n)`.
- Respondido "n" → negado, mesma mensagem de sempre, nada executado.
- Respondido "s" (rodada separada) → confirmado e executado, mesma
  mensagem de sempre.
- Conferido direto no `data/sarah.db` (não só pelo texto do agente):
  as três decisões batem exatamente (`ping`/`low`/`auto-allow`,
  `pretend_delete`/`high`/`denied`, `pretend_delete`/`high`/
  `confirmed`) — mesmo padrão de decisões que já existia antes desta
  refatoração.

## Decisões e bugs encontrados na Fase 4, parte 2 (Tray + janela reais)

**Escopo desta parte:** a janela/Tray de verdade, prevista como
próximo passo da parte 1. `apps/menubar` — segunda interface da SARAH,
lado a lado com `apps/cli`, sem substituí-lo.

### Refatoração necessária em `@sarah/core`: sessão em vez de loop de REPL

Antes desta parte, `@sarah/core` expunha só `runSarah()` — uma função
que TINHA o loop `while (true) { rl.question(...) }` dentro dela, ou
seja, assumia terminal. Uma janela Electron não pergunta "a próxima
linha" via `readline`, ela recebe eventos de IPC quando o usuário
aperta Enter. Extraído o loop pra fora: `@sarah/core` agora exporta só
`createSarahSession({ confirm })`, que monta o Gateway/audit log/
memória/tools MCP UMA VEZ e devolve `{ ask(prompt), close() }` —
`ask()` pode ser chamado quantas vezes forem necessárias, mantendo
`resume` entre chamadas. `apps/cli` passou a ter seu próprio loop
`readline` chamando `session.ask()` a cada linha (comportamento
revalidado como idêntico ao de antes); `apps/menubar` chama
`session.ask()` a partir de um handler de IPC. Nenhuma lógica de
Gateway/audit/memória foi duplicada entre os dois apps — só o "como
recebo o próximo pedido" muda, e isso é inerentemente diferente entre
uma interface e outra.

**Bug real corrigido no mesmo passo:** até aqui, o audit log e a
memória usavam caminho RELATIVO (`./data/sarah.db`), resolvido a
partir do `cwd` do processo — descoberto rodando de verdade que
`pnpm --filter cli dev` executa com `cwd` em `apps/cli/`, não na raiz
do monorepo (o `data/` real ficava em `apps/cli/data/`, não
`<raiz>/data/`). Com uma segunda interface, cada uma rodando de um
`cwd` diferente, isso quebraria a premissa de "audit log e memória são
compartilhados entre todas as interfaces". Corrigido resolvendo os
dois caminhos de forma ABSOLUTA a partir da localização do próprio
`packages/core/src/index.ts` (mesmo padrão já usado pra achar o
`.env`), sempre apontando pra `<raiz do repo>/data/`. Validado
rodando `apps/cli` e o daemon do `apps/menubar` em processos
separados, na mesma sessão de testes, e conferindo que as decisões de
AMBOS aparecem juntas, em ordem, no mesmo `data/sarah.db`.

### Parede real #1: `ELECTRON_RUN_AS_NODE=1` (já prevista na parte 1, resolvida aqui)

Resolvida no `package.json` do `apps/menubar`: `"dev": "env -u
ELECTRON_RUN_AS_NODE electron ."` — o processo que LANÇA o Electron
precisa limpar essa variável antes de invocar o binário; não dá pra
corrigir de dentro do próprio app, porque o bootstrap nativo do
Electron já checa essa variável antes de qualquer linha de JavaScript
nosso rodar.

### TypeScript dentro do processo principal do Electron: `tsx` programático

Igual o resto do projeto, todo o código de verdade deste app é
TypeScript, sem etapa de build — mas o `"main"` do `package.json` do
Electron só aceita um arquivo `.js`/`.mjs` de verdade, não um
comando (`tsx arquivo.ts` não serve como valor de `"main"`).
`main.js` (bootstrap de ~5 linhas, JavaScript puro — a ÚNICA parte
deste app que precisa ser JS, não TS) registra o loader do `tsx`
antes de importar o resto.

**Bug real encontrado testando isso isolado, antes de escrever o app
inteiro** (mesma metodologia de sempre): a forma "genérica" de
registrar um loader do Node (`node:module`'s `register("tsx/esm",
...)`) usa o mecanismo ANTIGO (`--loader`, depreciado desde o Node
20.6) — o próprio `tsx` detecta isso e recusa rodar: `"tsx must be
loaded with --import instead of --loader"`. A API certa é a que o
pacote `tsx` expõe especificamente pra esse uso
(`import { register } from "tsx/esm/api"; register();`) — registra do
jeito novo por baixo dos panos. Com a API certa, TypeScript (incluindo
`import` de `@sarah/core` e todo pacote workspace por trás dele)
carrega normalmente dentro do processo principal do Electron.

### Parede real #2: `better-sqlite3` tem ABI diferente dentro do Electron

A mais séria desta parte, encontrada só ao tentar rodar o app
completo (não o esqueleto mínimo, que não importava `@sarah/core`):
`require("better-sqlite3")` falhava dentro do processo do Electron
com `NODE_MODULE_VERSION 127 vs 148 requerida`. Diagnóstico, sem
assumir nada: `better-sqlite3` (dependência de `@sarah/audit` e
`@sarah/memory`) **não usa N-API** (que garantiria ABI estável entre
versões de Node/Electron) — seu `"install": "prebuild-install ||
node-gyp rebuild --release"` baixa um binário pré-compilado
ESPECÍFICO pra cada combinação de runtime+ABI; o que já tínhamos
instalado foi baixado pro Node do sistema (ABI 127, Node 22.13). O
Node EMBUTIDO no Electron 43.4.0 usa outra ABI (148,
`process.versions.modules` dentro do processo do Electron). Conferido
direto nos releases do pacote no GitHub (não assumido): a versão
instalada (11.10.0) só publica prebuilts de Electron até ABI 135; a
versão mais nova do pacote no npm (13.0.3) não tinha NENHUM prebuilt
de Electron publicado no momento desta checagem. Ou seja, sem um
prebuilt pra ABI 148, a única saída seria `node-gyp rebuild` de
verdade — que bateria na MESMA parede do Xcode Command Line Tools
quebrado que já tinha derrubado o `swiftc` na Fase 1.

Parado e perguntado ao usuário antes de tentar qualquer contorno
(conforme instrução explícita) — quatro opções levantadas: isolar o
SQLite num processo separado, baixar uma versão mais antiga do
Electron com ABI compatível, trocar de biblioteca SQLite pra uma
N-API de verdade, ou resolver o Xcode CLT e compilar localmente.
**Escolhida a primeira: isolar `@sarah/core` (e portanto
`better-sqlite3`) num processo FILHO separado**, rodado com o Node
NORMAL do sistema via `tsx` — o mesmo mecanismo que já roda
`apps/cli` — em vez do Node embutido do Electron. Resolve não só este
caso, mas qualquer módulo nativo futuro que a mesma restrição de ABI
afetasse (mais genérico que as outras três opções, que resolviam só
o SQLite ou dependiam do mesmo toolchain quebrado).

**Arquitetura resultante — dois arquivos novos:**

- `apps/menubar/src/daemon.ts` — processo FILHO. Cria a
  `SarahSession` de verdade (`createSarahSession` de `@sarah/core`) e
  fala um protocolo simples de JSON Lines (um objeto JSON por linha)
  via stdin/stdout com o processo pai. Recebe `{type:"ask", id,
  prompt}`, devolve `{type:"ask-result", id, ok, text|error}`. Quando
  o Gateway (dentro da sessão) precisa confirmar uma ação de alto
  risco, este processo NÃO sabe mostrar dialog nenhum — só manda
  `{type:"confirm-request", id, toolName, input, preview}` pro pai e
  ESPERA a resposta `{type:"confirm-response", id, approved}` antes
  de deixar o Gateway continuar (uma `Promise` pendente por `id`, num
  `Map`).
- `apps/menubar/src/sarah-daemon.ts` — lado PAI, dentro do processo do
  Electron. Sobe o processo filho (`spawn` apontando pro `tsx` local
  do app, não pro Node embutido do Electron), fala o mesmo protocolo,
  e repassa `confirm-request` pro `ConfirmFn` de verdade (o dialog
  nativo, ver abaixo) — o filho não sabe nada de Electron.

Robustez: as duas pontas ignoram silenciosamente qualquer linha que
não seja JSON válido (em vez de derrubar o protocolo), pro caso raro
de alguma dependência escrever algo inesperado em stdout/stderr.

**Validado em isolamento, ANTES de testar o app completo** (mesma
metodologia de sempre — testar a peça arriscada isolada primeiro):
um script standalone falou diretamente com `daemon.ts` via stdin/
stdout, sem Electron nenhum no meio:

- Um pedido de baixo risco (`ping`) → `ready` seguido de
  `ask-result` com `ok:true` e o texto de resposta certo, sem nenhum
  `confirm-request` (esperado, `ping` é baixo risco). Conferido no
  `data/sarah.db` compartilhado: `mcp__sarah-fixtures__ping`, `low`,
  `auto-allow`.
- Um pedido de alto risco (`pretend_delete`) → `confirm-request` com
  `toolName`/`input` corretos chegou ANTES do `ask-result`; simulado
  o usuário clicando "Cancelar" (`confirm-response` com
  `approved:false`) → `ask-result` confirmando a negação. Conferido
  no audit log: `mcp__sarah-fixtures__pretend_delete`, `high`,
  `denied`.

### Tray, janela e confirmação — o que foi construído

- **Ícone de Tray gerado em código** (um círculo preto simples,
  18x18, com alpha, via `nativeImage.createFromBitmap` — sem arquivo
  de imagem nenhum) com `setTemplateImage(true)`, que faz o macOS
  ajustar a cor automaticamente conforme o tema (claro/escuro) da
  barra de menu. Polimento visual (um ícone desenhado de verdade) foi
  deixado de propósito fora do escopo desta parte — o objetivo aqui
  era validar a FUNÇÃO.
- **Bug de Electron encontrado testando o esqueleto mínimo** (antes de
  construir o app inteiro): um `Tray`/`BrowserWindow` guardado só numa
  variável LOCAL de uma função/callback pode ser coletado pelo
  garbage collector do V8 assim que a função termina — corrigido
  guardando `tray`/`win`/`daemon` em `let` no escopo do MÓDULO, não
  dentro de `app.whenReady().then(...)`.
- **Clicar no ícone** alterna mostrar/esconder uma janela pequena
  (380x480), posicionada logo abaixo do ícone (`tray.getBounds()` +
  `win.setPosition(...)`, calculado a cada abertura). Fechar a janela
  pelo botão vermelho só ESCONDE (comportamento padrão de app de menu
  bar — o processo continua rodando); sair de verdade é só pelo menu
  de contexto (botão direito no ícone → "Sair") ou Cmd+Q.
  `app.dock?.hide()` tira o ícone do Dock — a barra de menu já é a UI.
- **`app.focus({ steal: true })` adicionado** antes de mostrar a
  janela: `app.dock?.hide()` muda a política de ativação do app pra
  "accessory" no macOS, que não ganha foco automático do mesmo jeito
  que um app normal — sem isso, a janela podia abrir atrás de outra
  já em foco.
- **Confirmação de alto risco**: `confirmViaDialog` (`ConfirmFn` de
  @sarah/permissions) usa `dialog.showMessageBox` — MESMA informação
  que o terminal já mostra (nome da tool + preview, ou o JSON cru do
  input quando não há `formatConfirmationInput` pra aquela tool),
  botões "Cancelar" (padrão/`cancelId`, pra Esc nunca confirmar
  sozinho) e "Confirmar".
- **Renderer sem framework** (HTML/CSS/JS puros, `contextIsolation:
  true` + `preload.cjs` com `contextBridge` — o renderer não tem
  acesso direto a Node/Electron): campo de texto + lista rolável de
  mensagens (Você/SARAH), usando `textContent` (nunca `innerHTML`)
  pro texto do usuário e a resposta do modelo, evitando qualquer
  interpretação como HTML.

### Validação visual — confirmada pelo usuário

Mesma lacuna de sempre nesta fase: sem permissão de Gravação de Tela
nesta máquina, a única forma de confirmar que Tray/janela/dialog
aparecem corretamente é o usuário testando de verdade — o roteiro
passo a passo (achar o ícone, clicar, pedido de baixo risco, pedido de
alto risco com dialog nativo, sair) foi seguido e confirmado
funcionando. Evidência independente, não só a palavra do usuário:
`data/sarah.db` (compartilhado com `apps/cli`) ganhou uma sequência
extensa de chamadas reais durante o teste — muito além do roteiro
mínimo pedido, incluindo `mcp__sarah-notion__create_event`,
`mcp__sarah-apple-reminders__create_reminder`,
`mcp__sarah-apple-notes__create_note` (duas vezes),
`mcp__sarah-gmail__create_draft` e `mcp__sarah-gmail__send_draft`
(`risk: high`, `decision: confirmed` — ou seja, o dialog nativo de
alto risco apareceu e foi confirmado de verdade pela janela do
Electron, não só o cenário do roteiro). **Fase 4, parte 2 completa.**

## Decisões e bugs encontrados na Fase 4, parte 3 (polimento visual + features)

**Escopo delegado ao critério do assistente**, com uma direção
específica pro item 1 (visualização holográfica azul); os outros três
itens (selo de tool, histórico, bolhas de conversa) ficaram livres de
implementação. Não muda nada do Gateway/audit log/memória/`apps/cli`
— só a camada visual/UX de `apps/menubar` por cima do que já existia.

### Item 1 — visualização holográfica central

**Proposta feita antes de implementar** (Three.js confirmado, não
ajustado): WebGL via Three.js pra um wireframe icosaédrico + partículas
em anel, geometria deliberadamente leve (icosaedro `detail=1`, ~42
vértices; 400 partículas) — o efeito "holograma" vem de
wireframe fino + glow aditivo, não de contagem de polígonos alta, então
o risco de performance percebida era baixo desde o design.

**Validado com medição real de FPS, não só assumido**: sem permissão
de Gravação de Tela, a única forma de confirmar performance foi
instrumentar o próprio `hologram.js` (`renderer/hologram.js`) pra
reportar a FPS média dos primeiros ~3s via `console.log`, encaminhado
do renderer pro terminal do processo principal
(`webContents.on("console-message", ...)`, em `main-process.ts` — sem
isso não haveria como ler o console do DevTools de forma nenhuma
nesta máquina). Três medições em execuções separadas: **92.8, 55.2 e
60.2 fps** — bem acima do limiar de "perceptível como travado"
(~30fps), confirmando que a visualização não introduz problema de
performance nesta máquina, mesmo rodando junto com o resto do app
(daemon filho, Gateway, IPC).

**Dois avisos reais encontrados e corrigidos durante essa validação**
(não relacionados a performance, mas capturados pelo mesmo
encaminhamento de console):
1. `THREE.Clock` está depreciado nesta versão do pacote (0.185.1) —
   trocado por `THREE.Timer` (API confirmada rodando um script Node
   isolado antes de trocar no código: `getDelta()`/`getElapsed()`
   equivalentes, mas precisa de `.update()` explícito por frame).
2. Aviso de segurança do Electron sobre CSP ausente — corrigido
   adicionando uma tag `<meta http-equiv="Content-Security-Policy">`
   restritiva (`default-src 'self'`) em `index.html` e `history.html`;
   nada neste app carrega recurso externo, então `'self'` (mais
   `'unsafe-inline'` só pro `<style>` embutido) já cobre tudo.

**Estado exposto (`renderer/hologram.js`)**: `setState("idle" |
"thinking")` — chamado em `renderer.js` no lugar exato onde antes
existia o texto "SARAH está pensando..." (removido, a animação é o
único indicador agora, como pedido) — e `setAudioLevel(nivel: number)`,
o gancho pra Fase de voz: já soma um "boost" na animação (pulso/
partículas) mesmo sem nenhuma chamada real ainda (fica em 0). Quando a
voz for implementada, basta chamar `setAudioLevel(volumeDoTTS)`
periodicamente — nenhuma mudança estrutural na visualização vai ser
necessária. Transição idle↔thinking suavizada por interpolação
(`energy` no código), não troca abrupta.

**Sem bundler**: Three.js importado direto do build ESM instalado
(`import * as THREE from "../node_modules/three/build/three.module.js"`)
— confirmado que o pacote expõe esse caminho antes de escrever
qualquer código (`npm view three exports`), o Chromium do Electron
resolve caminho relativo normalmente pra um módulo ES, sem precisar de
Webpack/Vite/esbuild.

### Item 2 — selo de tool + risco por resposta

Resolve o gap descrito pelo usuário: antes, saber qual tool rodou
numa resposta exigia consultar `data/sarah.db` via SQL — a interface
não mostrava isso sozinha. `ask()` (`@sarah/core`) passou a emitir
`SarahEvent` (`{type:"text"}` ou `{type:"tool", toolName, risk}`) em
vez de só texto — o mesmo stream de mensagens do Agent SDK já inclui
blocos `tool_use` (`{id, input, name, type:"tool_use"}`, confirmado no
tipo `BetaToolUseBlock` do SDK da Anthropic antes de assumir o
formato), então não precisou esperar o `onDecision` do Gateway pra
saber qual tool rodou. `apps/cli` recebe os mesmos eventos e ignora os
do tipo `"tool"` de propósito — saída do terminal continua idêntica à
de antes. O daemon deduplica tools repetidas no mesmo turno (preserva
a ordem da primeira aparição) antes de mandar pro processo principal.
Selo mostra `<emoji + nome amigável> · baixo/alto risco` (ex.: "🗓️
Notion · baixo risco"), com um mapeamento fixo por prefixo de server
em `renderer.js` — cai no nome cru se um server novo aparecer sem
entrada no mapa (nunca quebra).

### Item 3 — painel de histórico

Escolhida janela SEPARADA (não painel lateral): a janela principal já
é estreita (380px), uma segunda área ali competiria com o holograma/
conversa. Aberta pelo menu de contexto do ícone (botão direito →
"Histórico..."), busca os dados via um novo tipo de mensagem no
protocolo do daemon (`{type:"history", id, limit}` →
`{type:"history-result", id, entries}`), reusando
`AuditLog.recent()` (já existia desde a Fase 0, nunca duplicado) —
`SarahSession` ganhou um método `history(limit?)` que só chama isso.
`apps/menubar` define um tipo `HistoryEntry` PRÓPRIO em
`sarah-daemon.ts` em vez de importar `AuditRow` de `@sarah/audit`
— de propósito: o app não precisa de `@sarah/audit` (nem do
`better-sqlite3` por trás) como dependência direta, só do formato dos
dados que já chegam prontos via JSON do daemon.

### Item 4 — bolhas de conversa

Evitado o "template genérico de chat" de propósito (pedido explícito
do usuário) — paleta azul/marinho escuro consistente com o holograma
(`#060a14` de fundo, acentos `#3b82f6`/`#7dd3fc`), cantos NÃO
totalmente arredondados (assimétricos: um canto "reto" do lado de
quem fala, como um indicador de origem, mais parecido com painel de
HUD que bolha de chat comum), mensagens da SARAH com borda esquerda
azul + glow sutil (`box-shadow`) remetendo à mesma cor do wireframe do
holograma. Selo de tool (item 2) vive dentro da própria bolha, como um
rodapé discreto separado por uma linha fina.

### Validação — pendente de confirmação visual do usuário

Mesma lacuna de sempre (sem Gravação de Tela): validado
programaticamente tudo que dá pra validar sem olhar a tela —
protocolo de tools/histórico testado isolado contra o daemon real
(sem Electron no meio), FPS do holograma medido de verdade via
console encaminhado, nenhum erro nos dois renderers (janela principal
e histórico) nos logs encaminhados. A confirmação visual final (a
esfera anima e reage a "pensando", os selos aparecem, o histórico
lista as ações reais, as bolhas têm a identidade visual descrita) fica
para o usuário confirmar — resultado registrado na próxima atualização
deste arquivo.

## Decisões e bugs encontrados na Fase 4, parte 3.5 (dashboard com dado real)

**Regra absoluta do pedido, seguida à risca**: todo painel precisa de
uma fonte de dado REAL já existente no projeto — nenhum indicador
decorativo/inventado. Proposta feita antes de implementar (ver
abaixo) sinalizando explicitamente o que ficaria de fora por falta de
dado real, mesmo sem o usuário ter pedido a exclusão.

### Referência visual

O usuário enviou uma imagem de referência: uma esfera geodésica feita
de NÓS (pontos) conectados por linhas finas, com um ponto de luz
branco brilhante no centro, sobre fundo azul-marinho bem escuro com
vinheta radial. Isso é diferente do wireframe sólido genérico da parte
3 — o holograma foi refeito (`renderer/hologram.js`) pra seguir essa
linguagem: `IcosahedronGeometry(1.3, 2)` (~162 vértices) alimenta DOIS
objetos a partir da MESMA geometria — `THREE.Points` com uma textura
de ponto circular suave (gradiente radial gerado em canvas,
reaproveitada também pro núcleo) pros nós, e `THREE.EdgesGeometry` +
`LineSegments` pras arestas (evita as diagonais internas dos
triângulos que `WireframeGeometry` incluiria, ficando mais parecido
com uma malha geodésica limpa). O núcleo é um `Sprite` aditivo com
`depthTest: false` (sempre visível por cima da malha), pulsando mais
forte no estado "pensando" — o parâmetro mais natural pra reagir a
`setAudioLevel` no futuro (um "flash" a cada pico de volume do TTS).

### Proposta de painéis (feita antes de implementar) — o que tem dado real e o que não tem

- **Status das integrações**: viável pras cinco, mas com uma
  distinção importante que o pedido original não fazia — "configurada"
  (credenciais/permissão presentes) é diferente de "verificada
  funcionando agora" (exigiria uma chamada de API de verdade a cada
  abertura do painel, com custo de rede/latência). Implementado como
  "configurada", nunca "testada neste instante": Gmail e Notion via
  presença de env vars (+ Keychain no caso do Gmail); Apple Calendar e
  Apple Reminders via `EKEventStore.authorizationStatusForEntityType`
  (método de CLASSE do EventKit, real, sem pedir acesso nem ter efeito
  colateral — diferente de `requestAccessToEntityTypeCompletion`, que
  dispara o diálogo do macOS); Apple Notes não tem uma API de
  autorização consultável (Automation/Apple Events não expõe "só me
  diga, sem pedir") — o sinal real mais próximo é chamar
  `Notes.name()` (só pergunta o nome do app via Apple Events, não lê
  nem cria nada), aceito como proxy real, sinalizado como tal.
- **Proporção de risco** e **atividade por categoria**: viáveis sem
  ressalva, agregações diretas do audit log (`@sarah/audit` ganhou
  `riskCounts()`/`countByServer()`).
- **Atividade recente**: viável, mas só como contagem por HORA nas
  últimas 24h (`@sarah/audit.hourlyBuckets()`) — não tinha como
  inventar granularidade menor (minuto a minuto) sem dado real
  suficiente pra isso ser útil.
- **Módulos ativos**: sinalizado como REDUNDANTE com "status das
  integrações", não implementado como painel separado — a lista de
  servers MCP registrados é ESTÁTICA (todos os sete sempre registrados
  em `mcpServers`, independente de uso real), então "ativo" nesse
  sentido não seria um dado real diferente do que "status das
  integrações" já mostra. Os ícones de cada integração (item pedido
  aqui) foram incorporados DENTRO do painel de status em vez de um
  painel à parte.
- **Excluídos, confirmando os exemplos do próprio pedido**: voz/
  reconhecimento (sem voz implementada ainda), servidor/latência de
  rede (arquitetura é 100% local, não existe "servidor" pra medir) e
  qualquer selo de segurança tipo "encryption AES-256" (o projeto usa
  HTTPS padrão pras APIs externas e Keychain do macOS pro refresh
  token do Gmail — nenhuma alegação de criptografia específica além
  disso seria honesta).

### Validação — protocolo testado isolado, sem Electron no meio

Mesma metodologia de sempre: um script standalone falou direto com
`daemon.ts` (`{type:"dashboard", id}` → `{type:"dashboard-result", id,
data}`) antes de tocar em qualquer HTML/CSS. Resultado real desta
máquina, nesta sessão: as cinco integrações `configured: true`
(ambiente de desenvolvimento já configurado por completo);
`riskCounts` batendo exatamente com o total de chamadas já feitas
(`low: 15, high: 5`, soma 20); `categoryCounts` somando os mesmos 20,
maior atividade em `sarah-fixtures`/`sarah-gmail` (5 cada, reflete os
testes desta e de fases anteriores); `hourlyActivity` com 24 baldes,
22 zerados e 2 com atividade real concentrada nas duas últimas horas —
exatamente o padrão esperado de uso real numa sessão de
desenvolvimento, não dado inventado.

### Achado real de ambiente durante a validação de FPS: uma leitura de 7fps era ruído, não regressão

Uma medição isolada deu 7.0fps (bem abaixo do threshold de
"perceptível", ~30fps) — investigado antes de aceitar como problema
real. Instrumentado o holograma pra reportar FPS em DUAS janelas
(0-3s e 3-8s) e reconferido: leituras seguintes deram 53.7/58.8fps e
58.9fps, consistentes com as medições da parte 3. Causa raiz da
leitura ruim: processos Electron ÓRFÃOS de tentativas de teste
anteriores (incluindo uma tentativa de checar `app.getGPUFeatureStatus()`
que travou) ainda vivos e competindo por CPU/GPU exatamente durante a
janela de medição — confirmado pelo `ps aux` mostrando múltiplos
processos com PIDs antigos ainda de pé, limpos manualmente logo antes
da remedição. Não é uma regressão do código novo (geometria mais densa,
janela maior) — é uma armadilha da própria metodologia de teste
automatizado neste ambiente (processos zumbis de rodadas anteriores),
registrada aqui pra não ser reinvestigada à toa no futuro.

### Layout: janela cresceu, e o cálculo de posição precisou mudar junto

380x480 (só chat) → 760x760 (holograma maior + grade 2x2 de painéis +
chat). O cálculo antigo de posição (centralizar embaixo do ícone da
Tray) jogaria boa parte de uma janela desse tamanho pra fora da tela
em qualquer ícone perto da borda direita (comum, a barra de menu do
macOS enche da direita pra esquerda). Corrigido: alinha a borda
direita da janela com a borda direita do ícone (convenção comum de
painel de menu bar) e depois GRAMPEIA dentro de `display.workArea`
(`screen.getDisplayNearestPoint`) nos dois eixos — nunca nasce
parcialmente fora da tela, em qualquer monitor.

## Decisões e bugs encontrados na Fase 4, parte 4 (composição, espaçamento e animações contextuais)

Pedido: mesmo mockup de referência da parte 3.5, mas com foco em três
coisas diferentes — COMPOSIÇÃO (esfera dominante, painéis ao lado, não
embaixo), ESPAÇAMENTO (cartões de verdade, não linhas coladas) e
ANIMAÇÕES CONTEXTUAIS por categoria de tool. Nenhum dado novo — tudo
que já existia (audit log, Gateway, memória) ficou intocado.

### Composição: de "empilhado" pra "3 colunas com a esfera no centro"

Antes: `#hologram-wrap` (fixo, 250px) em cima, `#dashboard` (grid 2x2)
embaixo — a esfera era só mais um item no topo de uma lista vertical.
Agora: uma única região `#top`, grid de 3 colunas
(`210px 1fr 210px`), com um `.dash-col` (2 painéis empilhados, com
`gap` real entre eles) de cada lado e o holograma (320px de altura,
bem maior) centralizado no meio — a esfera passa a ser o elemento
dominante da composição, como no mockup, não um item entre outros.

Isso empurrou o tamanho da janela: 760x760 → **820x800**. Não é só
"deixar mais bonito" — com painéis de 210px de largura, algumas
métricas internas precisaram encolher pra caber sem quebrar feio: a
legenda de risco virou coluna (`flex-direction: column`) em vez de
lado a lado, e o rótulo de cada linha de "atividade por categoria"
caiu de 108px pra 74px.

### Espaçamento: painéis viram cartões de verdade

Antes, `#dashboard` tinha `gap: 1px` com um fundo escuro por trás
fazendo as "linhas" entre painéis — tecnicamente um grid, visualmente
uma grade apertada. Agora cada `.panel` é um cartão independente:
fundo em gradiente próprio (`linear-gradient`, levemente mais claro
que o fundo geral), `border-radius: 14px`, borda sutil (`#16233d`),
sombra (`box-shadow`) pra dar profundidade, e o espaçamento real entre
cartões vem do `gap: 14px` do `.dash-col` que os contém — não mais
frestas de 1px coladas.

### Achado revalidando o item 3 do pedido: o gráfico de 24h já vinha zero-preenchido, mas a barra "zero" era invisível

O pedido descreve o sintoma ("hoje só desenha barras onde existe dado,
deixando buraco vazio") como se fosse um problema na AGREGAÇÃO dos
dados. Conferindo `AuditLog.hourlyBuckets()` (`packages/audit`) antes
de mexer em qualquer coisa: os dados JÁ vêm zero-preenchidos desde a
parte 3.5 — as 24 horas sempre existem no array, nunca são omitidas.
O bug real estava só na APRESENTAÇÃO: a barra de uma hora com
`count: 0` tinha 1px de altura numa cor (`#10192c`) quase idêntica ao
fundo do painel (`#070b14`/gradiente escuro) — na prática, invisível a
olho nu, dando exatamente a impressão descrita ("buraco") mesmo com a
coluna tecnicamente presente no SVG. Corrigido só na apresentação
(`renderer/dashboard.js`): altura mínima maior (3px) e uma cor
claramente mais clara que o fundo (`#26385c`) pras 24 colunas ficarem
sempre visíveis como "barra baixa", nunca como vazio. Lição: quando o
sintoma descrito bate com uma decisão que já foi tomada
deliberadamente (aqui, zero-fill já existia e tinha até comentário
explicando o porquê), vale conferir a camada de APRESENTAÇÃO antes de
assumir que a camada de DADOS regrediu.

### Animações contextuais por categoria de tool — três versões até a arquitetura final

Este item passou por duas correções explícitas do usuário até chegar
na versão que ficou. Registro das três, porque a diferença entre elas
é a decisão de design mais importante deste item:

1. **Primeira versão**: cada categoria animava um ÍCONE dentro do selo
   de tool abaixo da mensagem (`.chip-icon`), com `memory.remember`
   fazendo um NÓ ALEATÓRIO da superfície da esfera piscar.
2. **Segunda versão** (1ª correção do usuário): só o `memory.remember`
   mudou — o pulso saiu do nó aleatório e foi pro NÚCLEO CENTRAL fixo.
   As outras categorias continuaram animando o ícone do selo.
3. **Versão final** (2ª correção do usuário, esta): o entendimento
   estava errado desde a primeira versão — a animação de TODAS as
   categorias nunca deveria ter sido um ícone junto ao selo. É o
   NÚCLEO CENTRAL da esfera que se transforma brevemente (~3s) pra
   mostrar a animação da tarefa que acabou de rodar, e depois volta ao
   estado normal (ocioso/pensando). O selo de tool continua existindo,
   só que como sempre foi antes deste item: texto puro, sem ícone
   animado nenhum — só registro ("🗓️ Apple Calendar · baixo risco").

### Arquitetura final: fila de tarefas dentro do holograma + overlay 2D sincronizado

`renderer/hologram.js` ganhou uma fila genérica (`playTask(category)` /
`taskQueue` / `currentTask`) — TODA categoria relevante (não só
`memory.remember` como na versão anterior) entra nela, e o próprio
`animate()` garante que só uma toca por vez: quando uma termina
(`TASK_DURATION = 3s`), a vaga libera e a próxima da fila só começa no
frame seguinte. Chamar `playTask()` várias vezes em sequência rápida
(ex.: duas tools na mesma resposta) empilha, nunca sobrepõe — validado
de propósito pedindo pra SARAH criar um lembrete E lembrar de uma
preferência na mesma mensagem (ver "Validação" abaixo).

Enquanto uma tarefa está ativa, o NÚCLEO 3D em si reage — cresce um
pouco além do seu pulso idle/thinking normal e ganha um halo (mesmo
mecanismo de brilho aditivo já usado na versão anterior, generalizado
pra qualquer categoria, não só memória). Isso sozinho já seria "o
núcleo se transforma", mas pra tornar CADA categoria reconhecível (uma
carta voando é visualmente diferente de um carimbo de calendário), um
overlay 2D (`#core-task` em `index.html`, SVGs simples desenhados à
mão — envelope, calendário+check, caneta+traço) fica posicionado
exatamente sobre o centro do canvas (onde o núcleo 3D sempre está, já
que ele vive na origem da cena com a câmera apontada pra lá) e mostra
o glifo certo, sincronizado com a MESMA janela de 3s via os callbacks
`onTaskStart`/`onTaskEnd` que `createHologram(canvas, callbacks)`
agora aceita. Cor do glifo ajustada por pedido do usuário depois da
primeira versão: PRETO (`#05070a`), não branco/azul-claro — o
glow/halo do núcleo por baixo é claro e apagava qualquer glifo
também claro; contraste extra contra o fundo escuro vem de duas
`filter: drop-shadow(...)` claras empilhadas (contorno só onde o SVG
tem traço, não uma cor de traço clara). `renderer.js` é
quem decide, por categoria, se existe glifo (`TASK_GLYPHS`) — categorias
sem entrada ali (hoje, só `"memory"`) não mostram overlay nenhum, só a
reação do núcleo em si já é a resposta visual, exatamente como pedido
("o núcleo pulsa/brilha mais forte — mesmo local, mesma duração").

Categorias e seus glifos:

- **Gmail `send_draft`** (`gmail-send`): envelope que "voa" pra fora
  do núcleo (translada, rotaciona, desaparece) — a mais elaborada de
  propósito, é a ação mais consequente do projeto.
- **Apple Notes `create_note` / Apple Reminders `create_reminder`**
  (`writing`, MESMA categoria pras duas): caneta com um wiggle curto +
  um traço desenhado (`stroke-dasharray`/`stroke-dashoffset`
  animando), simulando "algo sendo escrito".
- **Apple Calendar/Notion Calendar `create_event`** (`calendar-stamp`):
  ícone de calendário entra com overshoot elástico e um check é
  "carimbado" por cima (mesmo mecanismo de `stroke-dashoffset`).
- **`memory.remember`** (`memory`): SEM glifo — só a reação do núcleo
  (cresce/brilha) já responde por essa categoria.

`create_draft`/`reply_draft` (Gmail) e as tools de leitura (list_\*,
get_message, recall) de propósito NÃO têm `sphereTask` — o usuário só
listou 4 categorias desta vez (send_draft, notes/reminders create,
calendar/notion create_event, memory.remember), então nenhuma outra
tool ganhou reação no núcleo além dessas.

Categorização por tool é feita em `TOOL_META` (`renderer/renderer.js`):
uma lista de `{prefix, emoji, name, sphereTask}` onde o prefixo mais
LONGO que bate com o `toolName` qualificado (`mcp__<server>__<tool>`)
vence — permite ter uma entrada genérica pro server inteiro (sem
`sphereTask`) e uma mais específica só pra uma tool exata (com
`sphereTask`) na mesma lista, sem depender de ordem. Tool desconhecida
cai no fallback `{emoji: "", name: toolName, sphereTask: null}` —
nunca quebra, só não aciona nenhuma animação (mesmo princípio de
fail-safe já usado em `classifyRisk`).

A infraestrutura de cor-por-vértice da primeira versão (pra piscar um
nó aleatório) e as `@keyframes` por-ícone-no-selo da versão anterior a
esta foram REMOVIDAS por completo (não só desativadas) — nenhuma das
duas tem mais propósito com a arquitetura final.

### Validação de performance — quatro medições ao longo das versões (sem regressão real)

Medido de novo a cada mudança estrutural, não só assumido como
"desprezível" — mesma instrumentação de sempre (`console.log` de FPS
no renderer, encaminhado pro stdout do processo principal via
`webContents.on("console-message", ...)`, único jeito de validar isso
nesta máquina sem permissão de Gravação de Tela). Leituras ao longo
das três versões: 57.7fps (cor-por-vértice, depois de limpar
processos órfãos que causaram uma leitura inicial de 17.9fps),
55.6fps (núcleo + halo só pra memória), 58.3fps (arquitetura final,
fila genérica + overlay 2D). Todas dentro da mesma faixa saudável de
sempre (53-59fps) — nenhuma versão deste item introduziu regressão
real; a fila/overlay novos não pesam mais que as versões anteriores.

### Validação de dados e sequenciamento — protocolo testado direto (sem depender do clique do usuário)

Antes de pedir confirmação visual, chamado `daemon.ask()` diretamente
(via um gatilho temporário no processo principal, removido depois de
cada teste). Pra validar especificamente a FILA (item explícito do
pedido: "se duas tarefas acontecerem em sequência rápida, a segunda só
começa depois que a primeira termina"), o pedido de teste foi
desenhado pra causar DUAS tools com reação no núcleo na MESMA
resposta: "cria um lembrete de teste pra ligar pro dentista e também
lembre que eu prefiro reuniões de manhã". Resultado real:
`tools[]` chegou com `mcp__sarah-apple-reminders__create_reminder`
seguido de `mcp__sarah-memory__remember`, na mesma ordem em que o
modelo as chamou — confirma que `renderer.js` enfileira as duas via
`hologram.playTask()` na ordem certa, e que a fila dentro de
`hologram.js` (não o renderer, não o daemon) é a única responsável por
garantir que "writing" toca inteira antes de "memory" começar.

## Decisões e bugs encontrados na Fase 5, parte 1 (fundação do sandbox de código)

Primeira vez que a SARAH ganha capacidade de executar comandos e
escrever arquivos livremente — por isso esta etapa é só a FUNDAÇÃO
(verificar runtime + teste isolado + propor arquitetura), sem
implementar nenhuma tool ainda, seguindo instrução explícita.

### Achado real: nem Docker, nem "nada" — um meio-termo, mesma categoria do Xcode CLT na Fase 1

Conferido antes de qualquer coisa, não assumido: `docker`/`orbstack`/
`colima` não existem nesta máquina (nenhum binário no PATH, nenhum
app em `/Applications`, nenhum cask/formula do Homebrew). Mas
`podman` estava instalado via Homebrew (v5.0.1) — só que `podman
machine list` não mostrava NENHUMA VM criada, e `podman info`
confirmava explicitamente: `Cannot connect to Podman... try podman
machine init`. Ou seja: o binário existe, mas não funciona de
verdade — mesma categoria de achado da Fase 1 (Xcode CLT presente,
não operacional), então a sessão PAROU aqui, sem rodar `podman
machine init` sozinha, e perguntou ao usuário (via `AskUserQuestion`,
4 opções: inicializar a VM do podman já instalado, Docker Desktop,
OrbStack, Colima). Usuário escolheu inicializar a VM do podman
(opção recomendada — menor fricção, CLI já presente, sem app GUI
separado).

`podman machine init` baixou a imagem de VM (`quay.io/podman/
machine-os:5.0`, hypervisor nativo da Apple — `applehv`, arm64) e
`podman machine start` subiu a VM com sucesso. `podman machine list`
confirma os recursos default: 4 CPUs, 2GiB RAM, 100GiB de disco (a
VM inteira, não por container — cada container consome desse total).

### Teste mínimo isolado (mesmo padrão do teste do Electron na Fase 4)

Antes de desenhar qualquer tool, validado que containers funcionam
de verdade nesta máquina E que a garantia de isolamento é real, não
assumida:

1. `podman run --rm alpine:latest` — subiu, escreveu um arquivo
   dentro do container, leu de volta, rodou `uname -a`/`whoami`
   (Linux aarch64, root, dentro da VM), saiu. `podman ps -a` depois
   confirma zero resíduo (`--rm` funciona).
2. **Teste do isolamento em si** (o mais importante pro requisito de
   segurança): montado um diretório de teste do host como `/workspace`
   dentro do container (`-v <host>:/workspace:Z`), com `--network
   none`. Dentro do container: `/workspace` mostra só o arquivo que
   já existia lá (nada mais do Mac); um arquivo novo escrito em
   `/workspace` de dentro do container aparece no HOST depois (mount
   bidirecional funciona); `ls /Users` retorna `No such file or
   directory` — o sistema de arquivos real do Mac **não existe**
   dentro do container, não é só "sem permissão", é inacessível pela
   própria configuração (sem volume nenhum apontando pra lá);
   `wget` pra um domínio real falhou por falta de rede
   (`--network none` bloqueia de verdade, não é decoração).
3. **Limites de recurso**: `podman run --memory=256m --cpus=1 ...`
   e conferido de DENTRO do container via cgroups
   (`/sys/fs/cgroup/memory.max` = `268435456` bytes = 256MiB exato;
   `/sys/fs/cgroup/cpu.max` = `100000 100000` = 1 CPU inteira) — os
   limites são aplicados pelo kernel de verdade (cgroups v2 dentro da
   VM), não uma flag decorativa.

### Proposta de arquitetura (ainda não implementada — próxima etapa)

**Ciclo de vida do container**: um container POR PROJETO (não por
chamada de tool) — criado sob demanda na primeira operação daquele
projeto e mantido rodando enquanto o projeto está "aberto" (cada tool
subsequente usa `podman exec` nele, evitando o overhead de subir/
derrubar container a cada comando/escrita), mas continua descartável
no sentido que importa: destruído ao fechar/trocar de projeto, nunca
reaproveitado entre projetos, sem estado escondido sobrevivendo além
da pasta montada.

**Onde a pasta do projeto mora no HOST**: fora do repositório da
SARAH, de propósito — repetir o padrão de `packages/`/`data/` pra
projetos de código recriaria exatamente o problema já registrado no
`CLAUDE.md` ("Escopo do repositório git — cuidado": um repo git
aninhado dentro de outro por engano). Proposta: uma pasta irmã de
`Developer/jarvis`, ex. `~/SarahProjects/<slug-do-projeto>/`, cada uma
com seu próprio `.git` — nunca dentro da árvore deste repositório.

**Tools propostas** (nomes/formato, sujeitos a ajuste na próxima
etapa): `code.create_project(name)` (cria a pasta no host + `git
init` + sobe o container do projeto), `code.write_file(project, path,
content)` (path relativo a `/workspace`, nunca absoluto/fora dele),
`code.run_command(project, command)` (via `podman exec`, com timeout),
`code.git_commit(project, message)`, `code.git_push(project, remote,
branch, force?)` e `code.preview(project)` (sobe um dev server dentro
do container com port-forward explícito pro host, única porta de
entrada que existe).

**Risco**: `create_project`/`write_file`/`run_command`/`git_commit`
propostas como BAIXO risco — a garantia de segurança é o isolamento
do container em si (validado acima: sem acesso ao Mac real, sem rede
por padrão), não confirmação a cada linha de código escrita.
`git_push`/`git_push --force` continuam SEMPRE alto risco, sem
exceção — decisão já tomada desde o início do projeto, não muda aqui.

**Rede/recursos do container**: saída (outbound) liberada por padrão
— sem isso `npm install`/`git push`/`git clone` não funcionam, o que
inviabilizaria o propósito da ferramenta — mas SEM nenhuma porta de
ENTRADA exposta por padrão; só `code.preview` abre uma porta
específica, e só quando chamada. CPU/memória limitados por container
(`--memory`/`--cpus`, confirmado funcionando de verdade acima) com
valores default conservadores, ajustáveis por projeto se necessário.
Filesystem: SÓ a pasta daquele projeto montada (nunca o `$HOME` nem
qualquer outro caminho do Mac) — essa garantia vem da configuração do
`podman run`/`exec` (nenhum outro volume é montado), não de qualquer
checagem em nível de aplicação que pudesse ter um bug.

**Escopo desta etapa**: só isso — verificação do runtime, teste
isolado, e esta proposta. Nenhuma tool nova foi registrada em
`@sarah/core` ainda; isso fica pro próximo prompt, depois que a
fundação acima for confirmada.

## Decisões e bugs encontrados na Fase 5, parte 1 (b) — as três perguntas em aberto + implementação das tools

Depois da fundação acima, o usuário levantou três perguntas concretas
antes de liberar a implementação de verdade. As três foram resolvidas
TESTANDO, não só decidindo no papel — e duas delas revelaram bugs reais
que só apareceram rodando de verdade, não em revisão de código.

### 1. Ciclo de vida do container — dois gatilhos, não um

Decisão: um container por projeto, criado sob demanda na primeira
`code.*` chamada e mantido rodando enquanto o projeto está "aberto"
(chamadas seguintes usam `podman exec`, evitando o custo de recriar
container a cada comando). Encerrado por:

1. **Fim da sessão da SARAH** — `SarahSession.close()` (`@sarah/core`)
   agora também chama `stopAllProjects()`, no mesmo lugar que já fecha
   o audit log e a memória. `close()` virou `async` por causa disso
   (parar um container de verdade não é instantâneo); `apps/cli` e
   `apps/menubar/src/daemon.ts` foram ajustados pra `await` isso antes
   de `process.exit()`.
2. **Inatividade** — nenhuma chamada `code.*` pra um projeto por 30
   minutos (`IDLE_TIMEOUT_MS`) derruba o container sozinho (checado a
   cada 5 minutos, `setInterval` com `.unref()` — não impede o
   processo de encerrar por conta própria). Existe pra sessões muito
   longas (o daemon do `apps/menubar` pode ficar de pé por dias) não
   acumularem containers reservando CPU/memória se o usuário esquecer
   um projeto aberto.

Um container nunca é reaproveitado entre projetos diferentes — nome
fixo `sarah-proj-<slug>`, `--rm` garante que parar também remove.

### 2. Credencial de `git push` — testado e descartado o caminho óbvio

A sugestão natural (encaminhar o `ssh-agent` do usuário pro container,
reaproveitando a config já existente) foi TESTADA e não funciona nesta
máquina, por dois motivos concretos, não teóricos:

- `SSH_AUTH_SOCK` do macOS aponta pra `/var/run/com.apple.launchd.*` —
  fora de qualquer caminho compartilhado por padrão entre o Mac e a VM
  do podman (só `/Users`, `/private` e `/var/folders` são
  compartilhados via virtiofs, confirmado com `podman machine ssh --
  mount`).
- Mesmo que estivesse num caminho compartilhado, sockets Unix não
  atravessam esse tipo de compartilhamento de arquivo entre kernels
  diferentes (macOS vs. Linux da VM) — limitação conhecida desse tipo
  de virtualização, não um detalhe de configuração corrigível.

Decisão adotada (`packages/sandbox/src/git-credential.ts`): mesmo
padrão já usado pro refresh token do Gmail — uma credencial de deploy
POR PROJETO (não a identidade pessoal inteira do usuário) no Keychain
do macOS, lida pelo DAEMON (nunca pelo container) e escrita dentro do
container só no instante do `git_push`, num arquivo temporário na área
efêmera do container (nunca na pasta do projeto persistida no Mac),
apagado logo depois. Escopo por projeto é deliberado: uma chave
vazada limita o dano a UM repositório, não à conta inteira. Nenhuma
chave foi configurada nesta etapa — `git_push` recusa com mensagem
clara (`"Nenhuma credencial de git configurada..."`) se nada existir
no Keychain pra aquele projeto, testado de verdade (não só o caminho
feliz).

### 3. Escopo de rede — a parte mais difícil desta fase, três becos sem saída até funcionar

Pedido: container alcança internet, mas NÃO a rede local do Mac (outros
dispositivos na mesma LAN). Testado PRIMEIRO se isso já não seria o
caso por padrão — não era: um container na rede default do podman
conseguia abrir uma conexão TCP direto pro gateway da LAN
(`192.168.15.1:80`), confirmado com `nc` de dentro do container.
Precisou de três tentativas até achar o mecanismo certo:

1. **Regra `nft` no namespace de rede RAIZ da VM** (via `podman
   machine ssh`, sem `nsenter`) — sem efeito nenhum. Causa: o podman
   roda em modo ROOTLESS nesta VM, e o tráfego de CADA container passa
   por um network namespace PRÓPRIO daquele container (gerenciado por
   `pasta`), não pelo namespace raiz que `podman machine ssh` acessa
   por padrão. `nft list ruleset`/`iptables-save` no namespace raiz
   mostravam vazio mesmo com containers ativos — sinal de que o NAT de
   verdade acontece em outro lugar (gvproxy, na camada de rede da VM
   pro host, fora do netfilter do namespace raiz da VM).
2. **Tentativa de achar o "rootless netns" compartilhado** (o caminho
   de bind-mount que o `pasta` recebe como argumento `--netns`) — o
   `nsenter` pro caminho do arquivo falhava ("Invalid argument"), e
   entrar pelo PID do processo `pasta` mostrava as MESMAS interfaces
   do namespace raiz da VM (`pasta` conecta a esse namespace, não vive
   dentro dele o tempo todo).
3. **O que funciona**: `nsenter -t <PID> -n`, usando o PID do PRÓPRIO
   PROCESSO DO CONTAINER (`podman inspect <nome> --format
   '{{.State.Pid}}'`, confirmado que é o mesmo PID visto do Mac e de
   dentro da VM) — cada container tem seu PRÓPRIO netns individual (é
   assim que isolamento de container funciona, independente de
   rootless/rootful), e é ALI que a regra precisa entrar. Regra final,
   aplicada na cadeia `output` desse namespace específico: libera
   `10.89.0.0/16` (a própria subnet do sandbox — necessário pro DNS/
   gateway, que fica em `10.89.0.1`, dentro da faixa RFC1918
   `10.0.0.0/8` que seria bloqueada senão) e derruba
   `10.0.0.0/8`/`172.16.0.0/12`/`192.168.0.0/16`/`169.254.0.0/16`
   (toda a LAN de verdade). Internet continua liberada — a chain tem
   `policy accept`, só os destinos privados têm regra `drop` explícita.

**Validação de que a garantia é REAL, não decorativa** (o requisito
não-negociável do pedido: "impossível pela configuração, não apenas
desencorajada"): de dentro do próprio container, sem
`--cap-add=NET_ADMIN` nenhum concedido, foi instalado o pacote
`nftables` via `apk` (funciona — é tráfego de internet, não bloqueado)
e tentado `nft flush ruleset` — falhou com `"Operation not permitted"`.
Inspecionado `/proc/self/status` de dentro do container confirma:
`CapEff`/`CapPrm`/`CapBnd` não têm o bit de `CAP_NET_ADMIN` (bit 12) —
nem no conjunto BOUNDING, ou seja, o processo não pode nunca reaver
essa capacidade por nenhum meio (setcap, exec de binário suid etc.). A
regra sobreviveu intacta depois da tentativa, confirmado do lado de
fora (VM). O kernel recusa a chamada — não depende do container "se
comportar".

### Bug real #1 encontrado na validação: limpeza de container órfão matava sessão de OUTRO processo ainda vivo

A primeira versão de `cleanupOrphanedContainers()` (chamada uma vez no
início de cada sessão) apagava QUALQUER container `sarah-proj-*`
encontrado, sem checar se ainda pertencia a um processo VIVO. Isso
NUNCA foi testado com dois processos simultâneos até essa validação —
e o projeto suporta de propósito rodar `apps/cli` e `apps/menubar` ao
mesmo tempo (Fase 4). Reproduzido de verdade: um script criou um
projeto e ficou de pé (simulando um daemon real); um SEGUNDO script
(processo Node diferente) chamou `create_project` de novo — e sua
própria rotina de limpeza de órfãos matou o container do primeiro
processo, que ainda estava rodando o preview do usuário.

Corrigido (`packages/sandbox/src/podman.ts`): todo container de
projeto agora nasce com um label `sarah.owner-pid=<PID de quem criou>`.
`isOwnerAlive()` confere `process.kill(pid, 0)` (não manda sinal
nenhum, só pergunta ao kernel se o PID existe) antes de considerar um
container órfão — `cleanupOrphanedContainers()` e a checagem no início
de `createProjectContainer()` (que também tentava recriar um container
pré-existente sem essa checagem) só removem containers cujo dono
comprovadamente não existe mais. Se outro processo da SARAH ainda tem
aquele projeto aberto, a tentativa de abrir o mesmo projeto aqui falha
com uma mensagem clara em vez de derrubar a sessão alheia.

### Bug real #2 encontrado na validação: `:Z` (relabeling SELinux) quebra ao reabrir um projeto que já tem commits

A VM (Fedora CoreOS) roda SELinux em modo `Enforcing` (confirmado com
`getenforce`) — sem NENHUM tratamento de SELinux, o container recebe
"Permission denied" só de tentar LER `/workspace` (o mount funciona,
é o contexto de segurança que barra o acesso). A opção padrão pra
isso, `:Z` no volume (relabeling automático, exclusivo daquele
container), funciona na PRIMEIRA vez que um projeto é criado — mas
QUEBRA ao tentar recriar o container de um projeto que já tem um
commit: falha com `lsetxattr .../objects/.../permission denied`.
Causa: git grava objetos como somente-leitura (modo 0444 — comportamento
normal, não um bug do git), e a relabeling do `:Z` precisa de
permissão de ESCRITA no arquivo pra conseguir setar o xattr de
SELinux, permissão que um arquivo 0444 não dá nem pro próprio dono.
Reproduzido de propósito (criar projeto → commit → matar o processo
dono → reabrir o mesmo projeto) antes de aceitar como corrigido — e o
mesmo teste, depois da correção, funcionou (git log mostrou o commit
antigo intacto).

Corrigido: `--security-opt label=disable` no `podman run`, no lugar de
`:Z` — desliga a aplicação de SELinux especificamente pra este
container, sem tocar em nenhuma das outras garantias de isolamento
(rede, filesystem só a pasta montada, capacidades, limites de
recurso), todas revalidadas de novo DEPOIS dessa mudança pra confirmar
que continuam intactas (ver "Validação final" abaixo). SELinux aqui
protegeria contra um container malicioso mexendo em OUTROS containers/
processos da MESMA VM — não é o modelo de ameaça relevante numa VM de
uso único, dedicada só aos sandboxes da própria SARAH (diferente de,
por exemplo, um host multi-tenant compartilhado).

### Tools implementadas (`@sarah/sandbox`, MCP server `sarah-code`)

`code.create_project`, `code.write_file` (escreve DIRETO no host, não
via `podman exec` — `/workspace` é literalmente a pasta do projeto
montada, então os dois lados dão o mesmo resultado, sem o overhead de
entrar no container só pra um `cat > arquivo`; caminho validado duas
vezes contra `..`/absoluto pra nunca escrever fora da pasta do
projeto), `code.run_command` (via `podman exec sh -c`, com timeout),
`code.git_commit` (passa `-m`/mensagem como argv separado, NUNCA
interpolado numa string de shell — evita que `$(...)`/crase na
mensagem seja interpretado como comando), `code.git_push` (formatação
de confirmação própria em `packages/core` mostrando remote/branch/
force antes de pedir "sim/não" — mesmo padrão do `send_draft` do
Gmail) e `code.preview` (`podman exec -d`, porta 3000 do container
publicada só em `127.0.0.1` do Mac — nunca `0.0.0.0` — com um poll de
até ~12s checando se o servidor já responde antes de devolver a URL,
em vez de simplesmente confiar que o comando funcionou). Imagem base:
`node:20-alpine` (`git`/`openssh-client` instalados uma vez na criação
do container, não a cada comando).

Risco: as cinco primeiras entraram em `LOW_RISK_TOOLS`
(`@sarah/permissions`) — a garantia de segurança é o isolamento do
container, confirmação por linha não acrescentaria nada.
`git_push`/`--force` ficam de fora de propósito, SEMPRE alto risco,
sem exceção — regra que não mudou desde a primeira mensagem deste
projeto, nem "dentro" do sandbox.

### Validação final — ciclo completo, de verdade, incluindo o reinício de sessão

Um projeto de teste real (`site-de-teste-sarah`) passou pelo ciclo
inteiro: `create_project` → `write_file` (um `index.html`) →
`run_command` (`ls`/`node --version`/`git --version`, confirmando o
container de verdade) → `git_commit` (commit real, confirmado com
`git log`) → `preview` (`npx --yes serve`, instalado via internet de
dentro do container). A URL do preview foi conferida de FORA do
sandbox — `curl` direto do Mac, não de dentro do container —
retornando o HTML esperado com `http_code=200`.

Também validado o CENÁRIO DE REINÍCIO (matar o processo "dono" e
reabrir o mesmo projeto), que foi exatamente o que revelou os dois
bugs acima: depois de corrigidos, reabrir o projeto recria o container
sem erro, e o histórico git (commit de antes) continua intacto —
prova de que a persistência real está na pasta montada no Mac, não no
container em si (que é genuinely descartável).

Isolamento reconferido no container FINAL (depois de `--security-opt
label=disable`, pra garantir que essa mudança não afetou nenhuma das
outras garantias): `/Users` continua inacessível, LAN continua
bloqueada (`nc` pro gateway trava até dar timeout), internet continua
liberada, e `CAP_NET_ADMIN` continua ausente do processo do container
(`CapEff` sem o bit 12).

Também testado, real de verdade e via o AGENTE (não chamando as
funções diretamente): um prompt pedindo pra criar um projeto, escrever
um arquivo e rodar um comando — as três tools rodaram como
`auto-allow` (baixo risco, sem confirmação nenhuma pedida), registradas
no mesmo `data/sarah.db` de sempre, com o `input` exato de cada
chamada — confirma que a classificação de risco e o registro MCP
funcionam do jeito esperado através do caminho real (Gateway + audit
log), não só via chamada direta de função.

`git_push` NÃO foi testado contra um repositório remoto real, por
instrução explícita do usuário — só confirmado que a recusa por falta
de credencial funciona (`getProjectDeployKey` retorna `null` pra um
projeto sem chave configurada no Keychain).

**Confirmado pelo usuário**, visualmente, no navegador de verdade: o
preview do site de teste (`http://127.0.0.1:<porta>`) abriu e mostrou
o conteúdo esperado — validação end-to-end fechada, do prompt até o
navegador.

## Decisões e bugs encontrados na Fase 5, parte 2 (Base44 vs sandbox local — desambiguação)

Contexto: o conector nativo do Base44 (`mcp__claude_ai_Base44__*`, app
builder externo do próprio ambiente `claude.ai`, requer conta premium)
apareceu disponível junto das tools de `@sarah/sandbox`. Diferente do
conector nativo do Gmail (bloqueado de vez via `disallowedTools`, Fase
1 — porque a SARAH já tem sua própria tool de Gmail, melhor: OAuth
próprio, auditada, sem depender de sessão externa), o Base44 **não
tem equivalente próprio** e é uma escolha legítima do usuário (quem
tem conta premium pode preferir hospedagem pronta em vez do sandbox
local) — por isso a decisão aqui não é bloquear, é garantir que a
ESCOLHA entre os dois caminhos nunca seja feita pelo agente sozinho.

### Três camadas de reforço, não uma só

1. **Description da tool** (`create_project`, `packages/sandbox/src/index.ts`):
   instrui explicitamente a perguntar antes de agir quando o pedido não
   especifica o caminho.
2. **`systemPrompt` sempre injetado** (`BASE44_POLICY_TEXT`,
   `packages/core/src/index.ts`): a mesma regra, mas garantida em TODA
   chamada — não depende do modelo reler a description com atenção no
   meio de um pedido mais longo. Antes desta fase, o `systemPrompt`
   só levava um `append` quando havia preferência guardada
   (`preferencesText`); agora os dois textos são concatenados
   (`BASE44_POLICY_TEXT` sempre presente, `preferencesText` só quando
   existe alguma preferência).
3. **Gateway** (`FORCE_HIGH_RISK` em `@sarah/permissions`): cinto de
   segurança pro caso das duas primeiras falharem — TODA tool
   `mcp__claude_ai_Base44__*` é forçada a alto risco por um regex
   dedicado, verificado ANTES de checar `LOW_RISK_TOOLS`. Não é sobre
   destrutividade (várias tools do Base44 são só leitura, ex.
   `get_app_status`) — é sobre custo: qualquer chamada aciona um
   serviço pago, então precisa de confirmação explícita sempre, sem
   exceção, mesmo que uma dessas tools acabe entrando em
   `LOW_RISK_TOOLS` por engano no futuro. `formatConfirmationInput`
   (`packages/core/src/index.ts`) ganhou um caso pro Base44, mesmo
   padrão já usado pro `send_draft`/`git_push`: traduz o nome cru da
   ação (`BASE44_ACTION_LABELS`) e deixa explícito **"REQUER CONTA
   PREMIUM"** no preview, em vez de mostrar só o JSON do input.

### Validação de verdade — dois cenários, via o agente real

Script (`test-base44-ambiguity.ts`, scratchpad) chamou
`createSarahSession` de verdade, com um `confirm` que aprova só
`AskUserQuestion` (uma pergunta não tem efeito colateral nenhum) e
NEGA qualquer coisa que de fato crie/acione algo — de propósito, pra
nunca chegar a acionar o Base44 real nem gastar cota, só confirmar que
a PERGUNTA acontece no momento certo.

**Cenário 1 — pedido ambíguo** ("cria um site simples de portfólio pra
mim"): o agente chamou `AskUserQuestion` com exatamente as duas opções
esperadas ("Local (Claude Code)" / "Base44", com descrição de cada
uma) — **não** chamou `create_project` nem nenhuma tool do Base44
antes de perguntar.

**Achado lateral sobre o próprio `AskUserQuestion` neste ambiente
headless**: aprovado pelo Gateway, o tool call em si roda, mas como
nenhuma das interfaces deste projeto (`apps/cli`, `apps/menubar`) tem
um seletor visual interativo conectado a essa tool específica (só o
dialog s/n genérico do Gateway), ela volta sem uma escolha real
capturada. O agente reconheceu isso graciosamente e, em vez de travar
ou escolher por conta própria, respondeu em TEXTO pedindo pro usuário
escolher no próximo prompt — ou seja, a resposta de verdade chega pelo
próximo `ask()`, igual qualquer outra pergunta de esclarecimento do
agente (mesmo padrão já documentado na Fase 2 sobre `AskUserQuestion`
ser alto risco). Nenhum código mudou por causa disso — é o
comportamento correto de qualquer forma (nunca decide sozinho), só
fica registrado aqui pra não ser redescoberto do zero numa fase
futura que precise de um seletor visual de verdade (isso sim exigiria
trabalho extra em `apps/menubar`).

**Cenário 2 — pedido explícito** ("cria um site de portfólio simples,
usa o Base44"): o agente NÃO perguntou (o caminho já estava dito) e
foi direto pra `mcp__claude_ai_Base44__create_base44_app`. O Gateway
interceptou como alto risco e mostrou o preview novo:

```
Base44 — app builder externo, REQUER CONTA PREMIUM
Ação: criar um app novo no Base44 (a partir de uma descrição)
Entrada: {"appPrompt":"cria um site de portfólio simples, com uma página inicial"}
```

Negado de propósito (mesmo motivo do cenário 1: não acionar o serviço
de verdade) — o agente recuou de forma limpa, sem erro, oferecendo
retomar depois.

### Achado lateral (sem ação): `ToolSearch` não passa pelo Gateway

Durante o cenário 2, o agente chamou `ToolSearch` (mecanismo do
próprio Agent SDK pra carregar o schema de uma tool "deferida" antes
de poder chamá-la — necessário porque as tools do Base44 chegam desse
jeito) e essa chamada NÃO passou pelo `canUseTool`/Gateway (nenhuma
confirmação pedida, mesmo sendo classificada como alto risco só pelo
fail-safe de nome desconhecido). Registrado aqui, sem ação de código
agora: `ToolSearch` só consulta schemas (sem efeito colateral, não
executa nada), então não é um risco de verdade — mas vale saber que
esse mecanismo específico do SDK roda fora do Gateway, caso uma fase
futura precise que TODO tool call, sem exceção, passe pela auditoria.

## Decisões e bugs encontrados na Fase 5, parte 3 (GitHub automático — revoga o "sempre pergunta" da parte 2)

Instrução explícita do usuário: revogar a regra da parte 2 de sempre
perguntar "Base44 ou local" antes de criar um site/projeto. Regra
nova — `code.create_project` vira o caminho PADRÃO, sem perguntar
nada: cria a pasta local **e** um repositório novo no GitHub pra esse
projeto. Base44 só entra se o usuário pedir por nome. Risco: pasta
local + repositório VAZIO no GitHub continuam baixo risco (reversível,
nada enviado ainda); `git_push` de conteúdo continua sempre alto
risco, sem exceção — isso não mudou.

### Checagem pedida antes de implementar: a credencial existente serve pra CRIAR repositório?

Não. Confirmado empiricamente, não assumido — três checagens
separadas, todas negativas:

1. **A credencial já existente (`git-credential.ts`) é uma chave de
   deploy SSH por projeto** — só serve pra `git push`/`pull` num
   repositório que JÁ EXISTE (uma chave de deploy é cadastrada NO
   repositório depois que ele existe, via `POST
   /repos/{owner}/{repo}/keys`). Ela não dá acesso nenhum à API HTTP
   do GitHub, então não tem como criar um repositório novo com ela —
   isso é estrutural, não uma limitação de configuração.
2. **`gh` CLI não está instalado nesta máquina** (`which gh` →
   `command not found`).
3. **Nenhum token do GitHub configurado em lugar nenhum**: sem
   variável no `.env`, sem entrada no Keychain (`security
   find-generic-password -s sarah-code-github-token` → "item could
   not be found").

Ou seja, a suposição do pedido original ("reaproveitando a credencial
de git já configurada") não se sustentava — criar repositório é uma
operação de CONTA (`POST /user/repos` da API REST do GitHub), que
exige um token bem mais amplo que uma chave de deploy por projeto.

### Decisão: token de conta separado, checado na documentação oficial antes de escolher o tipo

Antes de decidir entre PAT clássico e PAT "fine-grained" (mais
restrito por natureza, preferível em teoria), consultei a documentação
oficial da REST API do GitHub pro endpoint `POST /user/repos`: ela
confirma escopo `repo`/`public_repo` pra PAT clássico, mas NÃO
documenta suporte equivalente pra fine-grained. Como criar
repositório é justamente a operação que este projeto precisa (e um
fine-grained token não pode ser pré-escopado pra um repositório que
ainda não existe), decidido usar PAT clássico, escopo `repo` — mais
amplo que o ideal, mitigado da seguinte forma:

- Guardado no Keychain do macOS (`sarah-code-github-token`), mesmo
  padrão do refresh token do Gmail.
- Usado SÓ pelo processo do daemon (nunca entra no container) — só
  em duas chamadas HTTP pontuais dentro de `create_project` (criar o
  repo + cadastrar uma chave de deploy nova).
- Depois de criar o repositório, o token amplo NÃO É MAIS NECESSÁRIO:
  uma chave de deploy NOVA (ed25519, gerada com `ssh-keygen` numa
  pasta temporária apagada logo depois) é cadastrada no repositório
  recém-criado com `read_write: true`, e salva no MESMO slot do
  Keychain por projeto que `git_push` já usava desde a Fase 5 parte 1
  (`getProjectDeployKey`/`saveProjectDeployKey`, sem nenhuma mudança
  nesse mecanismo). Ou seja: o blast radius de uma eventual chave
  vazada continua escopado por projeto pro dia a dia — só a operação
  de CRIAÇÃO usa o token mais amplo, uma vez por projeto.

### Setup: `pnpm github:auth`, mesmo padrão do `pnpm gmail:auth`

Diferente do Gmail (fluxo OAuth completo, loopback+PKCE — precisa de
um app OAuth registrado), um PAT clássico não tem esse aparato: o
usuário gera manualmente em
`https://github.com/settings/tokens/new` (escopo `repo`) e cola no
prompt do script. O script (`scripts/github-auth.ts`) valida com uma
chamada real (`GET /user`, confirmando o login associado) ANTES de
salvar — nunca aceita um token sem testar.

### Fail-safe: sem token configurado, `create_project` não quebra

Se `getGithubToken()` devolver `null` (estado padrão antes do
`pnpm github:auth`), `create_project` cria a pasta local normalmente e
devolve uma nota clara em vez de recusar — mesmo espírito de
`gitPush` recusando com mensagem clara em vez de travar. Erros DEPOIS
de já ter o token (API do GitHub fora do ar, limite de repositório
atingido, token revogado no meio do caminho) também não derrubam a
criação do projeto local — capturados e reportados como nota, mesmo
padrão `Promise.allSettled` já usado no dashboard.

### Validação real, via o agente — parte 1 (sem token configurado ainda)

Pedido "cria um site simples de teste... escreve um index.html
básico", sem mencionar caminho nenhum: o agente chamou
`create_project` e `write_file` DIRETO, sem perguntar nada (confirma a
revogação da regra da parte 2) — as duas rodaram como `auto-allow`
(baixo risco). Como nenhum token do GitHub estava configurado ainda
nesta validação, o agente reportou isso claramente ao usuário
("repositório remoto não foi criado porque... `pnpm github:auth`") em
vez de fingir que funcionou ou travar. Conferido no disco: pasta
criada em `~/SarahProjects/teste-sarah-github/` com o `index.html`,
SEM remote configurado, SEM commit ainda (nenhum `git_commit` foi
pedido) — exatamente o esperado pro caminho sem token. Reconfirmado
também que o pedido explícito "faz pelo Base44" continua funcionando
como antes (parte 2, inalterada): o agente foi direto pro Base44 sem
perguntar, e o Gateway interceptou com o preview de conta premium.

### Bug real #3 encontrado na validação com token de verdade: `security -w` devolve segredo multi-linha como HEX, não como texto

Depois do usuário configurar `pnpm github:auth` (token validado,
`GET /user` confirmando o login `ParisPS`, escopo `repo`), rodei o
fluxo completo de verdade: `create_project` → repositório privado
criado em `https://github.com/ParisPS/sarah-github-teste` → chave de
deploy provisionada → `write_file` → `git_commit` → `git_push`
(aprovado no Gateway). O push falhou com `Load key
"/tmp/.sarah_deploy_key": error in libcrypto` / `Permission denied
(publickey)`.

Investigado (não assumido): não era a geração da chave (`ssh-keygen`),
era o ARMAZENAMENTO. Reproduzido isolado, sem nenhum código do
projeto no meio — `security add-generic-password -w "$(printf
'line1\nline2\n')"` seguido de `security find-generic-password -w`
devolve `6c696e65310a6c696e65320a` (a string HEX-ENCODED, como texto),
não os bytes originais. Confirmado que valores de UMA linha só (ex.:
`"texto sem quebra de linha"`) fazem o round-trip perfeitamente — o
bug do `security` CLI é especificamente sobre conteúdo com quebra de
linha, que é exatamente o que uma chave privada SSH em formato PEM
sempre tem. Esse mecanismo de Keychain (`git-credential.ts`) nunca
tinha sido testado de ponta a ponta com uma chave de verdade até
agora — a validação da Fase 5 parte 1 só cobriu o caminho "recusa sem
credencial configurada" (por instrução explícita, pra não testar push
contra remoto real cedo demais).

Corrigido guardando o valor em base64 (`Buffer.toString("base64")` —
nunca insere quebra de linha) em vez do PEM cru, decodificado de volta
só na hora de usar. Revalidado apagando a chave quebrada do Keychain,
reabrindo o mesmo projeto (reprovisiona a chave automaticamente,
mesmo caminho de "projeto reaberto sem chave ainda" já existente) e
tentando o push de novo.

### Validação final — de ponta a ponta, conferida de FORA do fluxo (API do GitHub direto, não só o texto do agente)

Depois do fix, o `git_push` funcionou. Conferido direto na API REST do
GitHub (não confiando só na resposta do agente):

- `GET /repos/ParisPS/sarah-github-teste` → `private: true`,
  `default_branch: main`, `pushed_at` recente.
- `GET /repos/.../contents/index.html?ref=main` → conteúdo batendo
  exatamente com o que `write_file` escreveu ("Fase 5 parte 3
  funcionando").
- `GET /repos/.../keys` → chave de deploy cadastrada com
  `read_only: false` (read-write, como pedido).

Limpeza pós-validação: apagada via API a chave de deploy ÓRFÃ que
ficou registrada no GitHub durante o bug (a primeira tentativa, antes
do fix, gerou e cadastrou uma chave que nunca foi usada de verdade —
sem risco por ser só a parte PÚBLICA, mas removida por higiene).
Containers locais pararam normalmente ao fim de cada teste
(`session.close()`).

**O repositório de teste (`github.com/ParisPS/sarah-github-teste`) e a
pasta local (`~/SarahProjects/sarah-github-teste/`) foram deixados
como estão** — diferente de um container (efêmero por design), um
repositório no GitHub é um artefato real na conta do usuário; apagar
sem pedir seria uma ação difícil de reverter e de fora do escopo desta
sessão. Fica disponível pro usuário decidir se quer manter ou apagar.

## Decisões e bugs encontrados na Fase 5, parte 4 (gráficos vetoriais — SVG)

Nota de numeração: o pedido original chamou isso de "Fase 5, parte
2" — mas "parte 2" (Base44) e "parte 3" (GitHub automático) já
tinham sido fechadas antes. Documentado aqui como parte 4, pra manter
a numeração sequencial batendo com a ordem real de implementação.

Objetivo: `graphics.create_svg`/`graphics.export_raster`, sem API
externa nova — o próprio modelo escreve o SVG como texto (mesma
técnica de compor um mockup) e a tool só valida o mínimo e salva
dentro do MESMO sandbox de `code.*` (mesmo projeto, mesma pasta, mesmo
container). Por isso vive no mesmo pacote (`@sarah/sandbox`,
`graphics.ts` novo) e reusa `writeProjectFile`/`runProjectCommand` já
existentes, só com um servidor MCP novo (`sarah-graphics`) pra manter
os nomes de tool separados de `code.*`. Risco baixo, registrado em
`LOW_RISK_TOOLS` — mesma garantia de isolamento do container já
validada nas partes anteriores, nada de superfície de risco nova.

### Três achados reais testando a rasterização — nenhum assumido

Pedido explícito do usuário: confirmar que o container tem ferramenta
de conversão SVG→raster, testando, não assumindo. Testado num
container descartável (mesma imagem base, `node:20-alpine`) ANTES de
mudar `podman.ts`:

1. **`rsvg-convert` não vem junto do pacote `librsvg`** — são pacotes
   Alpine SEPARADOS (`apk search rsvg` lista os dois distintos).
   Instalar só `librsvg` deixa o binário `rsvg-convert` ausente.
2. **`imagemagick` sozinho não tem suporte a JPEG de verdade** —
   `magick foo.png -flatten foo.jpg` "funcionava" (saía código 0, um
   arquivo era criado), mas os magic bytes do arquivo eram de PNG
   (`89504e47`), não de JPEG (`ffd8ff`) — só percebido inspecionando
   os bytes, não só o exit code. Forçar o formato explicitamente
   (`JPEG:foo.jpg`) expõe o erro real: "no decode delegate for this
   image format". O pacote que falta é `imagemagick-jpeg` (delegate
   separado) — só com ele instalado o JPEG gerado tem os magic bytes
   certos e `magick identify` reconhece como JPEG de verdade.
3. **O mais sutil: texto em SVG renderiza INVISÍVEL, sem erro nenhum**
   — `rsvg-convert` processa um SVG com `<text>` sem falhar, sem
   warning, e devolve um PNG "válido" (magic bytes certos, dimensões
   certas) — só que a imagem base não tem NENHUMA fonte instalada
   (`fc-list` vazio, `fc-match sans` não devolve nada), então o texto
   é desenhado com uma fonte que não existe = nada. Só descoberto
   porque a validação incluiu ABRIR o PNG de verdade (via a tool
   `Read`, que renderiza imagem) em vez de só conferir magic
   bytes/exit code — um círculo azul perfeito, sem a letra que devia
   estar no meio. Corrigido instalando `ttf-dejavu` (fonte comum,
   licença permissiva); revalidado que o mesmo SVG passa a renderizar
   o texto certinho depois.

Os quatro pacotes (`rsvg-convert`, `imagemagick`, `imagemagick-jpeg`,
`ttf-dejavu`) entraram na mesma linha `apk add` que já instalava
`git`/`openssh-client` na criação do container (`podman.ts`,
`createProjectContainer`) — timeout do `apk add` aumentado de 30s pra
45s (a lista de pacotes cresceu, ainda que o tempo real medido tenha
ficado bem abaixo disso, ~3s).

### Design da tool: SVG é escrito pelo modelo, não gerado

`create_svg` recebe `svgContent` (o markup `<svg>...</svg>` completo,
composto pelo próprio modelo) — não existe geração de imagem
nenhuma dentro da tool, só uma validação leve (a string precisa conter
uma tag `<svg>`) e a escrita do arquivo dentro de `assets/` do
projeto. Um `description` opcional é embutido como `<title>`
acessível logo depois da tag `<svg>` de abertura — além de
acessibilidade, ajuda a identificar o arquivo em ferramentas como o
Illustrator, que costuma mostrar o título do documento.

### Validação de verdade

Via o agente real, reabrindo o projeto de teste da Fase 5 parte 3
(`sarah-github-teste`): pedido "cria um logo simples em SVG (círculo
azul com a letra S branca), exporta pra PNG e JPG" — `create_svg` e as
duas chamadas de `export_raster` rodaram como `auto-allow` (baixo
risco, sem confirmação nenhuma). Conferido no disco, fora do fluxo do
agente:

- `assets/logo.svg` — markup limpo, válido, `<title>` embutido
  corretamente.
- `assets/logo.png` — magic bytes de PNG confirmados via `xxd`.
- `assets/logo.jpg` — magic bytes de JPEG confirmados via `xxd`.
- **As duas imagens abertas de verdade** (não só os bytes) confirmam
  visualmente o círculo azul com a letra "S" branca legível no meio —
  incluindo depois de corrigir o bug de fonte ausente (a primeira
  rodada, antes do fix, gerava um círculo sem texto nenhum — revalidado
  depois do `ttf-dejavu` que o mesmo SVG passa a renderizar certo).

**Ajuste no critério de validação** (usuário sem Illustrator disponível
no momento): em vez de abrir no Illustrator, validado que `logo.svg`
abre corretamente num navegador de verdade (Chrome, via `open -a
"Google Chrome"`) e que `logo.png`/`logo.jpg` abrem no visualizador de
imagem padrão do macOS (Preview, via `open` sem app específico) —
**confirmado visualmente pelo usuário**, olhando as três janelas
abertas, que o círculo azul com a letra "S" aparece certinho nas três.
O teste do Illustrator continua pendente, não bloqueante, pra quando
o usuário tiver o aplicativo disponível.

### Quase-incidente durante esta validação: segredo exposto num screenshot

Tentando confirmar visualmente EU MESMO (em vez de só pedir pro
usuário olhar), tirei um screenshot de tela cheia (`screencapture`)
pra conferir o Chrome — mas o foco da tela estava no VSCode, não no
Chrome, e o screenshot capturou o terminal integrado com o **Personal
Access Token do GitHub em texto puro** (do `pnpm github:auth` rodado
numa sessão anterior, ainda no scrollback). Apagado imediatamente
depois de perceber. Numa segunda tentativa, mesmo confirmando o app em
primeiro plano ANTES da captura (via `lsappinfo front`, que não
depende de permissão de Acessibilidade), o foco mudou de novo entre a
checagem e a captura de fato — esse arquivo foi apagado SEM ser aberto
(por precaução, não arrisquei olhar de novo). Diagnóstico: o foco de
janela nesta máquina muda rápido/imprevisivelmente demais pra
`screencapture` automatizado ser confiável sem risco real de capturar
conteúdo sensível de outra janela.

**Decisão**: parar de tentar screenshot automatizado como método de
validação visual. Pra confirmar renderização visual de verdade, a
tarefa passa a ser: abrir os arquivos com `open`/`open -a` (o comando
em si não expõe nada, só instrui o macOS a abrir a janela) e pedir
confirmação direta do usuário olhando a própria tela — exatamente o
que já era o padrão pro Illustrator, agora estendido a qualquer
verificação visual que dependeria de eu "ver a tela" via screenshot.
Perguntado ao usuário se queria revogar o token exposto — decisão dele
foi manter o token como está.

## Bug real encontrado fora do escopo da Fase 5 parte 4 — shutdown do `apps/menubar` deixava container órfão

Achado sem relação com gráficos/SVG — descoberto restartando a própria
SARAH (`apps/menubar`) durante a validação desta fase, pra rodar o
código novo, com um projeto de sandbox aberto no meio. Corrigido na
hora por ser um caso real de recurso vazando (mesma categoria dos
bugs #1/#2 da Fase 5 parte 1), não porque fazia parte do pedido.

**Reproduzido**: com um projeto de `code.*` aberto (container
rodando), matar o processo principal do Electron (`kill -TERM` no PID,
ou até o fluxo "normal" de sair) podia deixar o container pra trás,
ainda rodando, órfão.

**Causa raiz, investigada (não assumida)** — dois problemas
empilhados:

1. `sarah-daemon.ts` (lado Electron da ponte com o processo filho
   `daemon.ts`) tinha um `stop()` "fire and forget": `child.kill()`
   sem esperar nada. `daemon.ts` tem um `shutdown()` assíncrono de
   verdade (`await session.close()`, que para cada container via
   `podman stop -t 5` — validado que isso legitimamente leva ~5-6s de
   verdade, não é instantâneo). O processo principal saía antes do
   filho terminar de parar o container.
2. `main-process.ts` só tratava `before-quit`/`will-quit` (eventos que
   só existem quando `app.quit()` é chamado pelo próprio app — Tray,
   Cmd+Q). Um `SIGTERM`/`SIGINT` direto no processo (ex.: `kill`,
   encerramento do sistema) nunca passava por esse caminho nenhum.

**Validado isoladamente, achado por achado**: um teste chamando
`daemon.ts` direto (via `spawnSarahDaemon`, o mesmo código que
`main-process.ts` usa) confirmou que o `shutdown()` do filho sozinho
funciona (~5.7s, container removido de verdade). Outro teste
confirmou que matar só o PROCESSO PAI (sem nunca sinalizar o filho)
deixa o filho como órfão, que SOZINHO detecta o stdin fechado e
completa o próprio shutdown — mas só depois de vários segundos, sem
qualquer garantia de que o pai (Electron) espere por isso.

**Corrigido**:

- `sarah-daemon.ts`: `stop()` virou `Promise<void>` — manda `SIGTERM`
  pro filho e só resolve quando o evento `exit` do filho dispara de
  verdade (com um `SIGKILL` de segurança depois de 8s, pra nunca
  travar o app pra sempre se o filho ficar preso por outro motivo).
- `main-process.ts`: `before-quit` agora intercepta a primeira
  tentativa de sair (`event.preventDefault()`), espera `daemon.stop()`
  de verdade, e só então chama `app.quit()` de novo (flag
  `shuttingDown` evita loop). `process.on("SIGTERM"/"SIGINT", () =>
  app.quit())` adicionados — sem isso, um sinal direto no processo
  nunca passava pelo `before-quit` nenhum.

**Revalidado depois do fix, em duas camadas — uma confirmou, a outra
NÃO se sustentou, corrigido aqui em vez de deixar a alegação errada**:

1. `daemon.stop()` isolado (chamando a função corrigida direto, fora
   do Electron, com um projeto de verdade aberto): confirmado que a
   `Promise` só resolve (~5.4s) DEPOIS que `podman ps` já não mostra
   mais o container. Essa parte do fix está correta.
2. **Através do processo real do Electron, com tracing temporário**
   (`appendFileSync` num arquivo, removido depois de confirmar):
   `before-quit` dispara e `daemon.stop()` é esperado de verdade antes
   do `app.quit()` seguinte — confirmado no caso SEM projeto aberto.
   MAS, testando de novo com um projeto de sandbox de verdade aberto e
   um `kill -TERM` direto no processo, o container ficou órfão de
   qualquer jeito — a alegação anterior (nesta mesma seção) de que
   "`process.on('SIGTERM'/'SIGINT', () => app.quit())` resolve isso"
   NÃO se sustentou no reteste. Investigado com o mesmo tracing: o
   listener do `process.on("SIGTERM", ...)` NUNCA chegou a disparar,
   mas `before-quit` disparou mesmo assim — ou seja, o próprio
   Electron parece interceptar `SIGTERM` nativamente e chamar algo
   equivalente a `app.quit()` por conta própria, sem passar pelo
   listener JS. Isso bate com um issue conhecido do próprio Electron
   (checado, não assumido): `process.on('SIGTERM')` não dispara de
   forma confiável no processo principal, especialmente em modo
   dev/não empacotado — que é exatamente como este projeto roda hoje
   (`pnpm --filter menubar dev`).

**Conclusão honesta**: o fix corrige de verdade o caminho GARANTIDO de
sair (Tray "Sair"/Cmd+Q, que chama `app.quit()` de verdade → passa por
`before-quit`). Um `kill -TERM` direto no processo (o que eu vinha
usando pra reiniciar a SARAH durante o desenvolvimento) continua sem
garantia de esperar o container parar, por uma limitação do próprio
Electron em modo dev, não corrigível só com código de aplicação. O
impacto disso é LIMITADO, não um vazamento permanente:
`cleanupOrphanedContainers()` (Fase 5 parte 1) já varre containers
órfãos (`sarah.owner-pid` + liveness) no início de qualquer sessão
nova — o container some na próxima vez que qualquer instância da
SARAH abrir um projeto, mesmo que este caminho específico não tenha
esperado. Registrado aqui pra não reaparecer como "resolvido" quando
não está — só o caminho normal de sair (Tray/Cmd+Q) tem garantia
forte; `kill -TERM` cru continua best-effort.

## Decisões e bugs encontrados na Fase 5, parte 5 (geração de slides — .pptx)

Objetivo: `slides.create_presentation(project, filename, outline)` —
gera um `.pptx` REAL (OOXML padrão) dentro da pasta do projeto.
Complementar ao Claude Design, não substituto: o mesmo arquivo pode
ser aberto e continuar editado no Claude Design, PowerPoint, Keynote
ou Google Slides depois.

### Tecnologia: `pptxgenjs` checado antes de decidir, não assumido

Pedido explícito do usuário: confirmar a maturidade/documentação
atual antes de aceitar a sugestão inicial. Checado de verdade (não só
lembrado de outra conversa):

- **npm**: versão `4.0.1`, última publicação ~1 ano atrás (meados de
  2025) — sem release novo recente, mas também sem marca de
  `deprecated`.
- **Downloads**: ~12,3 milhões/mês (via `api.npmjs.org`) — uso real,
  em escala, longe de abandonado.
- **GitHub**: MIT, definições TypeScript nativas inclusas, 6.000+
  estrelas, 3.463 commits, issues/PRs ainda ativos.
- **Comparação com alternativas** (busca dedicada): `pptxgenjs`
  continua listada como a opção mais popular; até uma alternativa mais
  nova (`pptx-automizer`, focada em editar templates `.pptx`
  existentes) usa `pptxgenjs` por baixo pra gerar conteúdo do zero —
  ou seja, não é a biblioteca certa pra ISSO, o próprio ecossistema
  ainda trata `pptxgenjs` como a base.

Conclusão: mantém a escolha original, mas VERIFICADA — o release
cadence mais lento não é sinal de abandono aqui, é coerente com um
formato (OOXML) estável que não pede releases frequentes só pra
continuar funcionando.

### Onde a geração roda: host, não dentro do container

Diferente de `graphics.export_raster` (que precisa de um binário de
sistema, `rsvg-convert`, e por isso roda via `podman exec` dentro do
container isolado), `pptxgenjs` é JavaScript puro — sem binding
nativo, sem dependência de binário nenhum. Não tem motivo pra pagar o
custo/complexidade de rodar dentro do container só por rodar; gera
direto no processo do daemon, mesmo espírito de `code.create_project`
criando o repositório do GitHub direto do host. A garantia de
segurança não muda: `resolveProjectFilePath` (extraído de dentro de
`writeProjectFile`, Fase 5 parte 1, agora reusado por `slides.ts`)
continua sendo a MESMA validação de path traversal — só a pasta do
projeto pode ser escrita, com ou sem container no meio.

### Formatação: capa separada + slides de conteúdo

`title` (da chamada) vira um slide de capa só com o título,
centralizado; cada item de `slides` vira um slide de conteúdo
(título + bullets, opcionalmente notas do apresentador). Layout
16:9 fixo (`defineLayout`), cores neutras — "formatação básica" como
pedido, sem tentar decidir um design elaborado que o usuário nem
pediu.

### Validação de verdade

Via o agente real, reabrindo o projeto de teste (`sarah-github-teste`,
mesmo da Fase 5 parte 3/4): pedido "cria uma apresentação sobre Marte,
5 slides". `create_project` (reabertura) e `create_presentation`
rodaram como `auto-allow` (baixo risco, sem confirmação). Conferido
fora do fluxo do agente, sem confiar só no texto da resposta:

- Magic bytes `PK\x03\x04` (um `.pptx` é um ZIP) confirmados via
  `xxd`.
- `unzip -l` confirma a estrutura interna esperada de um OOXML válido
  (`ppt/slides/`, `ppt/slideLayouts/`, etc.) e exatamente 6 arquivos
  `slideN.xml` (capa + 5 slides de conteúdo).
- Conteúdo de texto extraído direto do XML interno (`unzip -p ... |
  grep`) bate com o pedido — título e os 5 bullets do primeiro slide
  de conteúdo, legíveis.
- **Confirmado visualmente pelo usuário**, abrindo o arquivo de
  verdade (Keynote): os 6 slides (capa + 5 de conteúdo, cada um com
  título e bullets) aparecem corretos.

Upload no Claude Design pra confirmar edição contínua **não testado**
— não é algo scriptável por aqui (é um produto web, não uma CLI), e a
única tool de "design" disponível neste ambiente (`DesignSync`) é pra
outra coisa (sincronizar bibliotecas de componentes de design system,
não apresentações). Mesmo tratamento do teste do Illustrator na Fase
5 parte 4: pendente, não bloqueante, fica pro usuário quando quiser.

## Decisões e bugs encontrados na Fase 5, parte 6 (extração de assets do Figma)

Objetivo: `figma.export_assets(project, fileKey, nodeIds?, format?)` —
lê um arquivo do Figma do usuário (SÓ leitura, nunca escreve nada de
volta lá) e exporta fontes usadas, estilos de cor e imagens/
componentes pra `assets/figma/` do projeto, como insumo real pro
código gerado por `code.*` (Fase 5 parte 1). Editar o Figma
diretamente fica de fora de propósito, decisão separada pro futuro.

### Autenticação: checada na documentação oficial atual, não assumida

Pedido explícito do usuário. Confirmado em agosto de 2026
(developers.figma.com, não de memória):

- Token de acesso pessoal: Figma → menu da conta → Configurações →
  aba **Security** → "Personal access tokens" → "Generate new token".
- Diferente do que a API mais antiga do Figma pedia (um escopo amplo
  único, `files:read`, hoje DEPRECIADO): a criação do token hoje exige
  escolher escopos GRANULARES. Usados aqui: `file_content:read`
  (cobre document tree, estilos locais e o endpoint de exportação de
  imagens) + `current_user:read` (só pra validar o token com `GET
  /v1/me`, chamada de baixo privilégio, antes de salvar — mesmo
  padrão do GitHub).
- Header de autenticação: `X-Figma-Token: <token>` — NÃO é
  `Authorization: Bearer`, diferente do GitHub/outras APIs já
  integradas neste projeto. Confirmado antes de escrever qualquer
  código de cliente HTTP.
- Deliberadamente EVITADO o escopo `file_variables:read` (a API mais
  nova de "Variables" do Figma) — checado que é Enterprise-only; a
  extração de cor usa o mecanismo clássico de "Styles" (sempre
  presente no `styles` do retorno de `/v1/files/:key`, publicado ou
  não), que funciona em qualquer plano do Figma.

### Limitação real, documentada pra não ser prometida além do que existe

A API do Figma NÃO devolve o arquivo de fonte em si — fontes
comerciais/licenciadas não são redistribuíveis pela Figma. "Extrair
fontes" aqui significa só identificar NOME da família/peso usados
(pra o agente escolher uma equivalente disponível, ex. via Google
Fonts, ou avisar que precisa da fonte licenciada) — nunca baixar o
arquivo da fonte. Deixado explícito na description da tool, pra não
criar expectativa errada.

### Extração de cor: por que não dá pra usar só o endpoint de `styles`

O retorno de `/v1/files/:key` tem um `styles` de nível superior, mas é
só METADADO (nome + tipo do estilo) — não inclui o valor hex em si.
Pra pegar a cor de verdade, é preciso percorrer a árvore de nós,
achar um nó que referencia aquele estilo (`node.styles.fill` apontando
pro ID do estilo) e ler o `fills[0].color` DAQUELE nó (RGBA 0-1,
convertido pra hex aqui). Implementado assim — uma passagem só pela
árvore, coletando fontes/cores/candidatos-a-exportação juntos, não três
passagens separadas.

### Exportação de imagens: um formato por chamada, respeitando o que o designer já configurou

`/v1/images/:key` só aceita UM `format` (svg/png/jpg/pdf) por chamada.
Quando `nodeIds` não é passado explicitamente, a tool usa os nós que o
PRÓPRIO usuário já marcou pra exportação dentro do Figma
(`exportSettings` no nó — respeita a intenção do design, em vez de
tentar adivinhar o que exportar) — e usa o formato que CADA nó já tem
configurado lá, agrupando por formato antes de chamar a API (nós SVG
numa chamada, nós PNG noutra). O parâmetro `format` da tool só serve
de fallback pra quando `nodeIds` é passado manualmente e o nó não tem
`exportSettings` conhecido.

### Validação — bloqueada em duas credenciais/dados reais que não dá pra simular

Módulos carregam limpo, TypeScript tipa sem erro. A validação de
verdade (ler um arquivo real do Figma do usuário, exportar assets,
gerar um site de teste com fontes/imagens reais e comparar visual
antes/depois) depende de:

1. O usuário rodar `pnpm figma:auth` com um token de verdade.
2. Um arquivo do Figma de verdade do usuário (com fontes e alguma
   arte/logo real) pra apontar `fileKey`.

Nenhum dos dois pode ser fabricado — mesmo padrão já seguido pro
GitHub (Fase 5 parte 3) e pro Gmail (Fase 1): pausa aqui até o usuário
fornecer os dois, e a seção ganha uma "Validação final" depois.

### Bug real #1 encontrado testando com um token de verdade: campo `styleType` vs `style_type`

O usuário forneceu o token (`pnpm figma:auth`, autenticado como
"Paris PS") e um arquivo real
(`figma.com/design/QkiFeHLqU3WOgfiWassiXL/...`, "Dairy Products
Landing Page"). Testando a chamada crua a `GET /v1/files/:key` antes
de rodar qualquer código do projeto: o campo do mapa `styles` veio
como `styleType` (camelCase) — o resumo da documentação oficial
(buscado antes de implementar) tinha indicado `style_type`
(snake_case). Corrigido a interface TypeScript depois de inspecionar
a resposta real da API, não confiando no resumo sem checar contra o
JSON de verdade.

### Bug real #2 encontrado validando com o agente: nome de arquivo caía no ID cru quando `nodeIds` era passado manualmente

O arquivo de teste não tinha NADA marcado pra exportação dentro do
próprio Figma (`exportSettings` vazio em toda a árvore) — cenário
comum, principalmente em arquivos "Community" duplicados como este.
Isso forçou o caminho de `nodeIds` passado manualmente (IDs
descobertos inspecionando a árvore: `1:697` o componente "logo",
`1:347`/`1:353` dois cards de exemplo). Rodando de verdade, os
arquivos saíram como `1-697.svg` em vez de `logo.svg` — o código só
resolvia o NOME real do nó pra candidatos vindos de `exportSettings`
(`acc.exportables`), e caía no fallback `name: id` pra qualquer ID
passado manualmente, que é justamente o caminho mais comum na
prática. Corrigido indexando TODO nó por ID durante a mesma passagem
pela árvore (`WalkAcc.byId`), não só os marcados pra exportação —
revalidado depois que os arquivos saem com o nome certo
(`logo.svg`, `product-card.svg`, `recipe-card.svg`).

### Validação final — de ponta a ponta, com dados reais do usuário

Via o agente real, projeto `teste-figma-dairy`:
`figma.export_assets` (arquivo `QkiFeHLqU3WOgfiWassiXL`, `nodeIds`
manuais pelos motivos acima) rodou como `auto-allow` (baixo risco).
Conferido fora do fluxo do agente:

- `assets/figma/fonts.json` — 4 fontes reais (Playfair Display 400/
  700/900, Montserrat 400), batendo com o que o arquivo usa de
  verdade.
- `assets/figma/colors.json` — 2 estilos de cor nomeados (Omega
  `#ffffff`, Haze `#eff5fa`), extraídos andando pela árvore até um nó
  que referencia o estilo (o endpoint de `styles` só tem metadado, não
  o hex — ver seção de decisão acima).
- `logo.svg`/`product-card.svg`/`recipe-card.svg` — SVGs reais,
  abertos e conferidos (o logo é uma ilustração vetorial de verdade,
  não um placeholder).

**Site de teste comparando antes/depois**, pedido explícito do
usuário: gerados `index-before.html` (placeholder genérico —
`system-ui`, azul/cinza genérico, sem logo) e `index-after.html`
(MESMA estrutura de conteúdo, mas com fontes reais via Google Fonts,
cores reais de `colors.json`, e o `logo.svg`/cards reais embutidos).
Achado do próprio agente durante a geração, não um bug: Omega/Haze
sozinhas (branco + azul bem claro) não davam contraste suficiente pra
botões/preços — o agente usou o vermelho do próprio `logo.svg`
(`#E30613`) como cor de destaque, decisão razoável, documentada no CSS
gerado. **Confirmado visualmente pelo usuário**, abrindo os dois
arquivos de verdade (sem screenshot automatizado, mesma política
adotada na Fase 5 parte 4): a diferença entre o placeholder e a versão
com assets reais do Figma é clara.

## Decisões e bugs encontrados na Fase 5, parte 7 (Figma: três tentativas de arquitetura, e por que a Fase 5 fecha com uma pendência)

Correção de abordagem sobre a Fase 5 parte 6, confirmada com o
usuário: o site de teste gerado ali usava fontes/cores/logo REAIS
(via API REST), mas a ESTRUTURA e o CONTEÚDO continuavam sendo
inventados pelo agente interpretando o JSON cru do arquivo — o
próprio agente confirmou isso na hora. Pra "respeitar os componentes"
de verdade (pedido original do usuário), a hipótese inicial foi usar a
ferramenta que o próprio Figma construiu especificamente pra isso: o
**Dev Mode MCP Server**. Essa hipótese passou por TRÊS arquiteturas
diferentes nesta parte — as duas primeiras viraram becos sem saída
reais (não hipotéticos, cada uma bloqueada por um teste ao vivo), a
terceira é a que ficou.

### Tentativa 1 — Dev Mode MCP Server (Figma Desktop), abandonada: exige assento pago

Confirmado na documentação oficial antes de implementar: ativação via
Figma Desktop → Dev Mode (`Shift+D`) → painel de inspeção → "Enable
desktop MCP server"; endpoint `http://127.0.0.1:3845/mcp` (Streamable
HTTP); tool principal `get_design_context`. Implementado e validado
até o ponto possível sem gastar dinheiro (erro de setup claro, sem
travar, quando o servidor não está ligado). Bloqueado na prática
quando o usuário reportou, direto: **"dev mode tenho que pagar"** —
confirmado depois em help.figma.com que Dev Mode exige assento "Dev ou
Full" num plano pago (o plano Starter gratuito não inclui). Decisão:
não insistir nem sugerir pagamento — pesquisar a alternativa gratuita
e apresentar como opção, mesmo padrão já usado antes pro Docker/Xcode
CLT (Fase 5 parte 1) e pro Base44 (Fase 5 parte 2): nunca empurrar o
usuário pra pagar por conta própria. Código do cliente Dev Mode
DELETADO depois da decisão de abandonar (não ficou morto no repo).

### Tentativa 2 — Figma MCP Server remoto, abandonada: cliente customizado não é aceito

Usuário escolheu "trocar pro servidor remoto" (gratuito em qualquer
plano, `https://mcp.figma.com/mcp`, não exige Figma Desktop aberto —
usa link com `node-id`). Implementado do zero um cliente MCP completo
com OAuth 2.1 + PKCE + Dynamic Client Registration (RFC 7591),
modelado no exemplo oficial do próprio SDK (buscado direto do GitHub,
na tag exata da versão instalada — não assumido de memória), com
`OAuthClientProvider` persistindo client info/tokens no Keychain e um
servidor loopback local pro callback. Ao testar de verdade contra o
Figma, a chamada de registro do cliente (`registerClient`) devolveu
**HTTP 403 "Forbidden"**. Causa raiz confirmada na documentação oficial
do Figma (developers.figma.com/docs/figma-mcp-server/remote-server-installation/,
não assumida): só uma lista fechada de clientes pré-aprovados (VS
Code, Cursor, Claude Code) pode se conectar — não existe registro
dinâmico pra um cliente novo como a SARAH, só uma lista de espera
externa, sem prazo, fora do controle deste projeto. Bloqueio real,
não de configuração — confirmado com um erro ao vivo, não só lido na
doc. Apresentadas três opções ao usuário (esperar a lista de espera,
insistir em Dev Mode pago, ou melhorar a API REST já existente);
escolhida a terceira, explicitamente. Todo o código desta tentativa
(`figma-devmode.ts`, `figma-oauth.ts`, `scripts/figma-mcp-auth.ts`, a
dependência `@modelcontextprotocol/sdk` direta) foi DELETADO — as duas
tentativas MCP não deixaram rastro morto no código, só aqui na
documentação.

### Tentativa 3 — melhorar a API REST existente (a que ficou)

Achado chave: `document.characters` (o texto de VERDADE de cada nó
`TEXT`) e a hierarquia de frames/grupos/componentes já vinham no MESMO
`GET /v1/files/:key` usado desde a Fase 5 parte 6 — só não estavam
sendo usados. `buildContentTree` percorre a árvore mantendo só tipos
estruturalmente relevantes (`DOCUMENT`/`CANVAS`/`FRAME`/`GROUP`/
`SECTION`/`COMPONENT`/`COMPONENT_SET`/`INSTANCE`/`TEXT` — nós
puramente visuais como `VECTOR`/`RECTANGLE` ficam de fora, viram ruído
sem conteúdo) e grava `assets/figma/content.json`. Nenhuma chamada
nova ao Figma — é o MESMO `GET /v1/files/:key` já feito, só lendo mais
campos da mesma resposta.

**Validado de ponta a ponta** com o arquivo real "Dairy Products
Landing Page" (`teste-figma-dairy`): `content.json` saiu com texto e
estrutura genuínos — itens de navegação (Home/Catalog/Recipes/Our
Story/Certificates/Our Values), copy do hero, 7 produtos reais
(Graviera Naxou, Feta, Blue Cheese, White Cheese, Gouda, Edam, Rumi
Cheese), 3 receitas reais (Cheese Cake, Chicken Pizza with Onion,
Cheese Burger with Bacon), formulário de contato — nada inventado.
Gerado `index-real.html` do ZERO (não em cima do `index-before/after`
da parte 6, que tinham cópia inventada) usando só fontes reais
(`fonts.json`), cores reais (`colors.json` + hex reais lidos dos SVGs
já exportados — `#E30613`/`#F39200`/`#009FE3`, já que `colors.json` só
cobre estilos NOMEADOS/publicados, não todo fill solto do design) e o
`logo.svg` real. O que ficou honestamente marcado como NÃO real no
próprio HTML: fotos de produto/receita/hero (a API REST não devolve
essas imagens como asset exportável sem marcar nó a nó) e o layout
exato (aproximado a olho contra `reference.png`, um export real do
frame `landing-page-desktop` inteiro, não medido nó a nó).

### Achado real: rate limit do Figma é provavelmente MENSAL, não por minuto — e por quê

Exportar `reference.png` bateu **HTTP 429** na primeira tentativa,
liberou numa segunda tentativa ~1 minuto depois. Investigando a doc
oficial (developers.figma.com/docs/rest-api/rate-limits/, não
assumido): `GET file`/`GET file nodes`/`GET images` dividem a MESMA
cota, **Tier 1** — pra seat "View/Collab" (o mais provável pra uma
conta sem assento Dev/Full pago, mesma conta que já não tinha Dev
Mode), o limite é **até 6 chamadas por MÊS**, não por minuto; só seat
Dev/Full tem limite por minuto (10-20/min conforme o plano). Como as
três chamadas do endpoint (`GET file`, `GET file nodes`, `GET images`)
somam na MESMA cota, toda regeneração de `content.json`/`fonts.json`/
`colors.json` feita durante os testes desta sessão pode ter consumido
unidades da mesma cota mensal usada pra exportar imagem — o que
explica melhor um 429 depois de poucas chamadas do que throttling
normal por minuto. A resposta 429 do Figma traz `Retry-After`/
`X-Figma-Rate-Limit-Type`/`X-Figma-Plan-Tier`, mas o código não lia
esses headers até esta parte — corrigido a seguir.

### Otimizações implementadas pra minimizar chamadas contra uma cota possivelmente quase esgotada

Sem fazer NENHUMA chamada nova ao Figma pra testar (typecheck +
import local só) — combinado explicitamente com o usuário, que pediu
pra esperar a confirmação do seat real antes de qualquer chamada ao
vivo:

1. **Reaproveita IDs já obtidos**: `ContentNode` (a árvore de
   `content.json`) agora guarda o `id` real de cada nó do Figma — antes
   descartado, forçando uma chamada NOVA a `/v1/files/:key` só pra
   descobrir o ID de um componente antes de exportar como imagem. Como
   `content.json` já vem salvo em disco, o agente escolhe `nodeIds`
   direto dele, sem gastar cota nova.
2. **Batch por formato já existia, reforçado na description**:
   `exportImages` já agrupava nós do mesmo formato numa ÚNICA chamada a
   `/v1/images` (não uma por nó) — só não estava documentado pro
   agente usar assim. Description da tool e do parâmetro `nodeIds`
   atualizadas explicitamente: pedir N componentes do mesmo formato
   custa o mesmo que pedir 1.
3. **Log dos headers de rate limit**: novo `rateLimitInfo()` lê
   `Retry-After`/`X-Figma-Rate-Limit-Type`/`X-Figma-Plan-Tier` da
   resposta e anexa à mensagem de erro em `fetchFigmaFile` e
   `exportImages` — da próxima vez que um 429 acontecer, a mensagem já
   diz se é cota mensal (`low`) ou throttling por minuto (`high`), sem
   suposição.

### Pendência explícita — Fase 5 fecha sem esconder isso

**Figma está implementado e tecnicamente funcional, mas BLOQUEADO na
prática pelo rate limit do plano gratuito do Figma** (Tier 1, ~6
chamadas/mês, compartilhadas entre leitura de arquivo e exportação de
imagem). Dois projetos reais do usuário estão prontos e parados
esperando decisão sobre upgrade pro plano Professional do Figma:
`food-products-site` e `natural-beauty-products-site`. Não seguimos
testando contra a cota até o usuário confirmar o seat real dele no
arquivo (Viewer/Collab vs Dev/Full) direto pelo figma.com — decisão
explícita de não gastar mais chamadas de uma cota que pode já estar
quase esgotada só com os testes desta sessão. Isso fica registrado
como pendência real, não como "Fase 5 parte 7 completa" — ver Roadmap
e "Próximo passo concreto" abaixo.

## Roadmap completo (pra não perder o fio)

0. Fundação — monorepo, Agent SDK, Gateway, audit log. **(feito)**
1. MVP — Apple Calendar (**feito**: list_events + create_event) +
   Notion Calendar (**feito**: create_event, calendário principal) +
   Apple Reminders (**feito**: list_reminders + create_reminder) +
   Gmail (**feito**: list_recent_emails, leitura, OAuth próprio),
   interface terminal. **(Fase 1 completa)**
2. Memória estruturada + preferências (**feito**: `@sarah/memory`
   — remember/recall/forget persistentes + injeção determinística de
   preferências via `systemPrompt` — e memória de SESSÃO via `resume`
   do Agent SDK, corrigida nesta mesma fase). **(Fase 2 completa)**
3. Apple Notes (**feito**: list_notes + create_note, scripting via
   `Application("Notes")`) + ações de e-mail (**feito**: get_message,
   create_draft, reply_draft — baixo risco, aditivo/reversível — e
   send_draft, **alto risco**, decisão deliberada de habilitar envio
   real de um rascunho já existente, com confirmação melhorada
   mostrando o conteúdo legível). **(Fase 3 completa)**
4. App de menu bar nativo substituindo o terminal; voz opcional.
   **(Fase 4 completa até a parte 4: framework decidido — Electron —,
   Gateway desacoplado de terminal, `@sarah/core` isolado num daemon
   Node separado do Electron (ABI do `better-sqlite3`), Tray + janela
   reais com confirmação via dialog nativo, dashboard com holograma
   (referência visual seguida) + 4 painéis de dado REAL (status de
   integrações, proporção de risco, atividade por categoria/hora),
   composição em 3 colunas com a esfera centralizada/dominante,
   painéis como cartões espaçados de verdade, e o NÚCLEO CENTRAL da
   esfera se transformando brevemente (~3s, numa fila que nunca
   sobrepõe duas animações) pra mostrar qual tarefa acabou de rodar —
   tudo validado rodando de verdade. Voz integrada também, em duas
   etapas — STT/TTS isolados e depois integrados na interface (mic
   sempre visível, esfera com estado "ouvindo", fala de toda resposta,
   toggle de idioma de saída) —, e o dashboard ganhou um segundo
   polimento (preenche a janela inteira, legenda com link clicável,
   widget de clima/localização/hora, ícones SVG). Ver seção própria
   "Fase 4 (Voz)" mais abaixo pro detalhe de cada etapa. **Fase 4
   completa.**)**
5. Agente de código: sandbox por projeto, criação de projetos, git.
   **(Fase 5 parte 1 completa: runtime verificado — podman, VM
   inicializada, `docker`/OrbStack/Colima ausentes nesta máquina —
   ciclo de vida do container decidido (sessão + timeout de
   inatividade), credencial de `git_push` resolvida via Keychain por
   projeto (ssh-agent forwarding testado e descartado — não funciona
   nesta configuração), rede local bloqueada de verdade (nftables no
   netns do próprio container, validado que o container não consegue
   desfazer) mantendo internet liberada. `@sarah/sandbox` implementado
   e registrado em `@sarah/core`: `code.create_project/write_file/
   run_command/git_commit/git_push/preview`. Validado de ponta a ponta
   com um projeto real — site estático, commit real, preview
   respondendo via `curl` externo — incluindo o cenário de reiniciar a
   sessão (dois bugs reais encontrados e corrigidos nesse teste:
   limpeza de container órfão matando sessão alheia ainda viva, e
   relabeling SELinux quebrando ao reabrir projeto com commits). **Fase
   5 parte 2 completa**: o conector nativo do Base44 (app builder
   externo, conta premium) ficou disponível a propósito, mas nunca
   escolhido sozinho pelo agente — desambiguação em três camadas
   (description da tool, `systemPrompt` sempre injetado, e
   `FORCE_HIGH_RISK` no Gateway forçando alto risco com preview
   explicando "requer conta premium"), validada de ponta a ponta via o
   agente real em dois cenários (pedido ambíguo → pergunta antes de
   agir; pedido explícito "usa o Base44" → Gateway intercepta e avisa
   sobre a conta premium). **Fase 5 parte 3 completa**: revogado o
   "sempre pergunta" da parte 2 — `create_project` virou o caminho
   PADRÃO, criando pasta local E repositório privado no GitHub sozinho
   (token de conta separado, escopo `repo`, usado só pelo daemon,
   nunca entra no container; auto-provisiona uma chave de deploy só
   pro projeto logo depois, então o token amplo não é necessário de
   novo). Base44 só entra se pedido por nome. Validado de ponta a
   ponta com um token real: repositório criado, `write_file` +
   `git_commit` + `git_push` reais, confirmados direto na API do
   GitHub (não só no texto do agente) — incluindo um bug real
   encontrado e corrigido nessa validação (`security -w` devolvia
   segredos multi-linha como hex em vez do texto original; toda chave
   SSH batia nisso — corrigido guardando em base64 no Keychain). **Fase
   5 parte 4 completa**: `graphics.create_svg`/`graphics.export_raster`
   — o modelo escreve o SVG como texto (sem geração de imagem), a tool
   só valida e salva em `assets/` do mesmo sandbox; rasterização via
   `rsvg-convert`+`imagemagick`, três achados reais testando (não
   assumindo) — `rsvg-convert` é pacote separado de `librsvg`,
   `imagemagick` sozinho não tem delegate de JPEG de verdade, e a
   imagem base não tem NENHUMA fonte instalada (texto em SVG renderiza
   invisível, sem erro — só descoberto abrindo o PNG de verdade, não só
   conferindo os bytes). Todos corrigidos e revalidados abrindo as
   imagens geradas de verdade.)** **Fase 5 parte 5 completa**:
   `slides.create_presentation` gera um `.pptx` real via `pptxgenjs`
   (maturidade checada de verdade, não assumida — ~12,3M downloads/mês,
   ainda a base do ecossistema JS pra isso), direto no host (JS puro,
   sem precisar do container), reusando a mesma validação de path
   traversal de `code.write_file`. Complementar ao Claude Design, não
   substituto. Validado de ponta a ponta: estrutura OOXML/ZIP
   conferida por fora (magic bytes, `unzip -l`, texto extraído do XML
   interno) e **confirmado visualmente pelo usuário** abrindo o
   arquivo de verdade no Keynote. Upload no Claude Design não testado
   — não é scriptável por aqui, fica pendente/não bloqueante. **Fase 5
   parte 6 completa**: `figma.export_assets` lê um arquivo do Figma
   (SÓ leitura, nunca escreve de volta lá) e exporta fontes usadas
   (nome/peso — não o arquivo da fonte, o Figma não redistribui isso),
   estilos de cor nomeados e imagens/componentes pra `assets/figma/`
   do projeto. Autenticação checada na documentação oficial atual
   (escopos granulares `file_content:read`+`current_user:read`, header
   `X-Figma-Token`, não assumido de memória antiga). Validado de ponta
   a ponta com um arquivo real do usuário — dois bugs reais corrigidos
   no processo (campo `styleType` vs `style_type` assumido errado dos
   docs; nome de arquivo caindo no ID cru quando `nodeIds` era passado
   manualmente, o caminho mais comum já que a maioria dos arquivos não
   tem nada marcado pra exportação dentro do próprio Figma) — e um
   site de teste comparando placeholder genérico vs. versão com
   fontes/cores/logo reais do Figma, **confirmado visualmente pelo
   usuário**. **Fase 5 parte 7 — encerrada com pendência explícita,
   não completa**: três arquiteturas tentadas pra "respeitar os
   componentes" de verdade — Dev Mode MCP desktop (abandonada: exige
   assento pago) e Figma MCP remoto (abandonada: `HTTP 403` real no
   registro de cliente, allowlist fechada do Figma, sem registro
   dinâmico) — até chegar na que ficou: melhorar a própria API REST
   com `content.json` (estrutura + texto de VERDADE de cada nó,
   `document.characters`, sem gastar chamada nova) e cada `id` de nó
   reaproveitável direto de lá. Validado de ponta a ponta com um
   arquivo real (texto/estrutura genuínos, nada inventado,
   `index-real.html` gerado do zero) — mas **bloqueado na prática**
   pelo rate limit do Figma (Tier 1, ~6 chamadas/mês pra seat sem
   assento pago, compartilhado entre leitura de arquivo e exportação
   de imagem — achado real, não suposição, confirmado na doc oficial
   de rate limits). Código já otimizado pra minimizar chamadas
   (reaproveita IDs, batching por formato, loga headers de rate
   limit), mas dois projetos reais do usuário (`food-products-site`,
   `natural-beauty-products-site`) ficam parados esperando decisão
   sobre upgrade de plano do Figma.
6. GitHub completo (commits, PRs) + deploy de sites. **(Fase 6 —
   Pull Requests — completa)**: `code.create_pull_request`, fluxo de
   branch obrigatório pra mudança em projeto já existente
   (`code.git_create_branch`, baixo risco), `create_pull_request`
   sempre alto risco (mesmo nível de `git_push` — na prática É um
   `git_push` por dentro, antes de abrir o PR). Merge fica de fora DE
   PROPÓSITO, sem tool própria — só o usuário mescla pelo GitHub.
   Validado de ponta a ponta com `createSarahSession` real (mesmo
   Gateway/confirmação/audit log de `apps/cli`/`apps/menubar`) contra
   um projeto real já existente: dois Pull Requests abertos de
   verdade no GitHub (`social-post-community` #1 e #2), passando
   por branch → commit → push confirmado → PR, sem merge automático.
   **Deploy de sites continua FORA do escopo**, decisão já tomada
   antes — usuário resolve manualmente, não retomado nesta fase.
7. Memória semântica (embeddings via Voyage AI) + observabilidade +
   nuance no risco médio. **(Fase 7 parte 1 completa)**: `memory.recall`
   funde busca por palavra-chave (FTS5) com busca por similaridade
   semântica (`sqlite-vec` + embeddings da Voyage AI, `voyage-4-lite`)
   via Reciprocal Rank Fusion; `memory.remember` detecta preferência/
   fato semanticamente parecido ANTES de gravar e pergunta ao usuário
   se é pra substituir ou manter as duas, em vez de empilhar
   silenciosamente uma contradição — resolvendo as duas notas
   pendentes da Fase 2, sem abrir mão da garantia "preferência vale
   sempre" (nenhum filtro de relevância na injeção do systemPrompt,
   só um teto consultivo de aviso). **(Fase 7 parte 2, primeira peça,
   completa)**: `tool_calls` (`@sarah/audit`) ganhou `status`/
   `error_message`, preenchidos pelos hooks `PostToolUse`/
   `PostToolUseFailure` do Agent SDK depois que a tool roda de
   verdade — não só a decisão do Gateway antes de rodar. Painel
   "Erros recentes" novo no dashboard. Nuance no risco médio e o
   resto de observabilidade continuam pendentes.
8. Novas integrações e expansões.

## Próximo passo concreto

**Fase 3 está completa** (Apple Notes + ciclo inteiro de e-mail,
incluindo `send_draft`, validados rodando de verdade — detalhes na
seção acima).

**Fase 4 está completa** (partes 1-4 da interface + as duas etapas da
voz) — resumo:

- **Parte 1**: framework decidido (Electron, por não depender de
  compilação nativa local) + Gateway (`@sarah/permissions`)
  refatorado pra receber `confirm` injetado em vez de `readline`
  preso dentro.
- **Parte 2**: `apps/menubar` construído — Tray + janela reais,
  `@sarah/core` extraído de `runSarah()` (loop de terminal) pra
  `createSarahSession()` (reusável por qualquer interface), isolado
  num processo daemon Node separado (contorna a ABI incompatível do
  `better-sqlite3` dentro do Electron), audit log/memória
  compartilhados de verdade entre `apps/cli` e `apps/menubar` via
  caminho absoluto. Validado pelo usuário rodando de verdade,
  incluindo um `send_draft` (alto risco) confirmado pelo dialog
  nativo.
- **Parte 3**: polimento visual + features, critério do assistente —
  visualização holográfica (Three.js, com gancho `setAudioLevel` já
  pronto pra Fase de voz), selo de tool+risco por resposta, painel de
  histórico em janela separada, identidade visual própria pras
  bolhas de conversa.
- **Parte 3.5**: dashboard mais denso, seguindo referência visual
  enviada pelo usuário (esfera geodésica de nós+linhas+núcleo
  brilhante) — 4 painéis, TODOS com dado real (status de integrações,
  proporção de risco, atividade por categoria, atividade por hora nas
  últimas 24h); "módulos ativos" e indicadores de voz/rede/segurança
  ficaram de fora por não terem fonte de dado real disponível agora
  (ver seção acima pro porquê de cada um). Janela cresceu de 380x480
  pra 760x760, posicionamento recalculado pra nunca sair da tela.
  Performance revalidada com medição real de FPS em duas janelas de
  tempo (~54-59fps) — uma leitura anômala de 7fps investigada e
  atribuída a processos órfãos de testes anteriores, não a regressão.
- **Parte 4**: composição mudou de "esfera em cima, painéis embaixo"
  pra 3 colunas com a esfera centralizada/dominante e painéis dos dois
  lados; cada painel virou um cartão de verdade (fundo próprio, cantos
  arredondados, padding generoso, gap real); gráfico de 24h corrigido
  (o zero-fill já existia desde a parte 3.5, mas a barra "zero" era
  visualmente invisível — cor/altura ajustadas). O item de animações
  contextuais passou por duas correções do usuário até a versão final:
  não é mais um ícone animado no selo de tool (que volta a ser só
  texto, como antes deste item) — é o NÚCLEO CENTRAL da esfera que se
  transforma brevemente (~3s, fila própria dentro do holograma que
  nunca sobrepõe duas animações) pra mostrar qual tarefa acabou de
  rodar: envelope voando pro Gmail `send_draft`, caneta escrevendo pra
  Notes/Reminders `create`, calendário carimbado pra Calendar/Notion
  `create_event`, e o próprio núcleo brilhando/crescendo (sem glifo)
  pra `memory.remember`. Janela cresceu de 760x760 pra 820x800.
  Performance remedida a cada versão do item — mesma faixa saudável de
  sempre em todas (53-59fps), sem regressão real (as leituras ruins
  isoladas foram, de novo, processos órfãos de teste, não o código
  novo).

**A voz foi implementada em duas etapas, ambas completas** — ver
"Decisões e bugs encontrados na Fase 4 (Voz)" mais abaixo pro detalhe
de cada uma: primeira etapa validou STT (whisper.cpp)/TTS (`say`)
isolados, com áudio real; segunda etapa integrou tudo na interface
(microfone sempre visível, esfera com estado "ouvindo", toda resposta
falada em voz alta, toggle PT/EN de idioma de saída) e, num segundo
ajuste pedido depois de ver a primeira versão rodando, também resolveu
o espaço vazio da composição, deu um propósito real à área de legenda
(link clicável pra arquivos/URLs que a SARAH acabou de criar), trocou
os ícones de emoji por SVG, e acrescentou um widget de data/hora/
clima/localização. **Fase 4 está completa.**

**Fase 5, parte 1 está completa** (sandbox de código, fundação +
implementação): `docker`/OrbStack/Colima ausentes nesta máquina,
`podman` presente mas com VM não inicializada — parado e perguntado ao
usuário antes de inicializar (mesma cautela do Xcode CLT na Fase 1);
usuário escolheu inicializar a VM do podman. Depois de validar o
runtime, três perguntas em aberto foram resolvidas TESTANDO (não só
decidindo): ciclo de vida do container (sessão + timeout de 30min de
inatividade), credencial de `git_push` (Keychain por projeto — ssh-
agent forwarding testado e confirmado que NÃO funciona nesta VM), e
bloqueio de rede local mantendo internet (nftables aplicado no netns
do próprio container, de fora dele — confirmado que o container não
consegue desfazer, falta `CAP_NET_ADMIN` até no conjunto bounding).
`@sarah/sandbox` implementado com as 6 tools propostas
(`create_project/write_file/run_command/git_commit/git_push/preview`)
e registrado em `@sarah/core`. Validado de ponta a ponta com um
projeto real (site estático — escrita, comando, commit real, preview
respondendo via `curl` externo ao sandbox) — incluindo o cenário de
reiniciar a sessão, que revelou e permitiu corrigir dois bugs reais:
limpeza de container órfão matando a sessão de OUTRO processo ainda
vivo (corrigido com um label de PID dono + checagem de liveness), e
relabeling SELinux (`:Z`) quebrando ao reabrir um projeto que já tem
commits git (corrigido com `--security-opt label=disable`, sem afetar
nenhuma das outras garantias de isolamento, revalidadas depois da
mudança). `git_push` não foi testado contra um remoto real, por
instrução explícita — só a recusa por falta de credencial.

**Fase 5, parte 2 está completa** (Base44 vs sandbox local —
desambiguação, detalhes na seção acima): o conector nativo do Base44
não foi bloqueado — fica disponível como caminho alternativo legítimo
pra quem tem conta premium — mas a escolha entre ele e `code.*` nunca
é decidida sozinha pelo agente, reforçada em três camadas (description
da tool, `systemPrompt` sempre injetado, e `FORCE_HIGH_RISK` no
Gateway). Validado rodando de verdade via o agente: pedido ambíguo →
pergunta antes (`AskUserQuestion` com as duas opções corretas);
pedido explícito "usa o Base44" → Gateway intercepta com preview
mencionando a conta premium.

**Fase 5, parte 3 está completa** (GitHub automático — revoga o
"sempre pergunta" da parte 2, detalhes na seção acima): checado antes
de implementar que a credencial existente (chave de deploy por
projeto) NÃO serve pra criar repositório (é estrutural — deploy keys
só existem depois que o repo já existe); nem `gh` CLI nem token nenhum
estavam configurados. Implementado um PAT clássico de conta (escopo
`repo`, checado contra a documentação oficial antes de escolher o
tipo), guardado no Keychain via `pnpm github:auth`, usado só pelo
daemon pra criar o repo + provisionar uma chave de deploy nova por
projeto (token amplo não é mais necessário depois disso). Validado de
ponta a ponta com um token real do usuário: repositório privado
criado, arquivo escrito, commit e push reais, tudo conferido direto na
API do GitHub — incluindo um bug real encontrado e corrigido nesse
teste (`security -w` devolvendo segredos multi-linha como hex em vez
do texto original, afetando toda chave SSH guardada no Keychain;
corrigido guardando em base64).

**Fase 5, parte 4 está completa** (gráficos vetoriais — SVG, detalhes
na seção acima): `graphics.create_svg`/`graphics.export_raster`,
registradas no servidor MCP novo `sarah-graphics`, reusando o mesmo
sandbox/projeto de `code.*` — sem API externa nova, o modelo escreve o
SVG diretamente como texto. Testado (não assumido) que a imagem base
do container tinha gaps reais pra rasterização — três achados
corrigidos: `rsvg-convert` é pacote separado de `librsvg`,
`imagemagick` sozinho não converte JPEG de verdade (faltava o
delegate), e a imagem base não tinha nenhuma fonte instalada (texto em
SVG renderizava invisível, sem nenhum erro — só percebido abrindo o
PNG de verdade). Validado de ponta a ponta via o agente real, no
mesmo projeto de teste da parte 3: logo criado em SVG, exportado pra
PNG e JPG, as duas imagens abertas e conferidas visualmente. Critério
de validação ajustado depois (usuário sem Illustrator disponível):
SVG aberto no Chrome, PNG/JPG abertos no Preview, **confirmados
visualmente pelo próprio usuário** — não por screenshot automatizado
(ver "quase-incidente" logo acima: uma tentativa de screenshot chegou
a capturar um token do GitHub em texto puro no terminal por trás,
apagado na hora; decisão foi parar de automatizar captura de tela pra
validação visual). Illustrator continua pendente, não bloqueante.

**Fase 5, parte 5 está completa** (geração de slides — `.pptx`,
detalhes na seção acima): `slides.create_presentation`, servidor MCP
novo `sarah-slides`, gera um `.pptx` OOXML real via `pptxgenjs` —
maturidade da biblioteca CHECADA de verdade antes de aceitar a
sugestão original (npm, downloads, GitHub, comparação com
alternativas), não assumida. Roda direto no host (JS puro, sem
container) reusando a mesma validação de path traversal de
`code.write_file` (extraída pra `resolveProjectFilePath`, reusável).
Complementar ao Claude Design, não substituto. Validado de ponta a
ponta: estrutura OOXML/ZIP conferida por fora (magic bytes, `unzip
-l`, texto extraído do XML interno batendo com o pedido) e
**confirmado visualmente pelo usuário** abrindo o arquivo de verdade
no Keynote. Upload no Claude Design não testado (não é scriptável por
aqui) — pendente, não bloqueante, mesmo tratamento do Illustrator.

**Fase 5, parte 6 está completa** (extração de assets do Figma,
detalhes na seção acima): `figma.export_assets`, servidor MCP novo
`sarah-figma`, SÓ leitura/exportação do Figma (nunca escreve de volta
lá) — fontes usadas (nome/peso, não o arquivo da fonte), estilos de
cor nomeados (hex, resolvido andando pela árvore até um nó que usa o
estilo, já que o endpoint de `styles` só tem metadado) e imagens/
componentes exportados pra `assets/figma/` do projeto. Autenticação
checada na documentação oficial atual do Figma antes de implementar —
escopos granulares (`file_content:read`+`current_user:read`), header
`X-Figma-Token`. Validado de ponta a ponta com um arquivo real do
usuário (token configurado via `pnpm figma:auth`, arquivo real do
Figma) — dois bugs reais corrigidos durante a validação: o campo
`styleType` (a documentação resumida tinha indicado `style_type`,
errado) e o nome de arquivo caindo no ID cru quando `nodeIds` era
passado manualmente (caminho mais comum, já que a maioria dos
arquivos do Figma não tem nada marcado pra exportação lá dentro).
Gerado um site de teste comparando placeholder genérico vs. versão
com fontes/cores/logo reais do Figma — **confirmado visualmente pelo
usuário** que a diferença é clara.

**Fase 5, parte 7 (Figma — três arquiteturas, detalhes na seção
acima)**: tentativa 1 (Dev Mode MCP desktop) e tentativa 2 (Figma MCP
remoto) foram implementadas e abandonadas, cada uma por um bloqueio
real testado ao vivo (assento pago; `HTTP 403` no registro de cliente
OAuth, allowlist fechada do Figma sem registro dinâmico) — nenhuma das
duas ficou como código morto no repo, as duas foram deletadas depois
da decisão de abandonar. Tentativa 3 (melhorar a API REST da parte 6
com `content.json` — estrutura + texto real de cada nó, sem gastar
chamada nova ao Figma) foi a escolha final do usuário, implementada e
**validada de ponta a ponta com um arquivo real**: texto/estrutura
genuínos extraídos (nada inventado pelo agente), `index-real.html`
gerado do zero (não em cima do site com cópia inventada da parte 6).
Depois de um `HTTP 429` real durante a validação, uma investigação na
documentação oficial de rate limits do Figma revelou que `GET file`/
`GET file nodes`/`GET images` dividem a MESMA cota (Tier 1), só ~6
chamadas por MÊS pra uma conta sem assento Dev/Full pago — não por
minuto. Três otimizações implementadas pra minimizar chamadas futuras
(reaproveitar IDs já obtidos em vez de reconsultar o Figma, garantir
que exportação de vários componentes do mesmo formato seja SEMPRE uma
única chamada, logar os headers de rate limit da resposta), sem gastar
NENHUMA chamada nova ao testar essas otimizações — combinado
explicitamente: só volta a chamar o Figma depois do usuário confirmar
o seat real dele no arquivo (Viewer/Collab vs Dev/Full).

**Registrado como PENDÊNCIA EXPLÍCITA, não como "completa"**: Figma
está implementado e tecnicamente funcional, mas bloqueado na prática
pela cota do plano gratuito do Figma. Dois projetos reais do usuário
prontos e parados esperando decisão sobre upgrade pro plano
Professional do Figma: `food-products-site` e
`natural-beauty-products-site`.

---

## Fase 5 — encerrada nesta sessão, com uma pendência registrada

Partes 1 a 6 completas e validadas rodando de verdade (detalhes em
cada seção acima): sandbox de código por projeto (Podman, isolamento
de rede/filesystem confirmado com teste real) + criação automática de
repositório privado no GitHub + `git_push` sempre atrás de confirmação
de alto risco (validado com push real) + Base44 como caminho
alternativo nunca escolhido sozinho pelo agente (parte 1-3); gráficos
vetoriais SVG (parte 4); geração de slides `.pptx` (parte 5);
extração de assets do Figma via API REST (parte 6). Duas decisões
conscientes de escopo, não esquecimentos: **imagem realista** (raster,
via API paga tipo Flux/GPT Image/Firefly) foi avaliada e o usuário
decidiu não seguir por enquanto; **vídeo** foi descartado do escopo
desta fase, não retomado sem pedido explícito.

**Parte 7 (Figma — estrutura/conteúdo reais) fica como a ÚNICA
pendência explícita da Fase 5** — não escondida, não maquiada de
"completa": implementado, otimizado, validado tecnicamente, mas
bloqueado na prática pela cota do plano gratuito do Figma (ver seção
acima). Fase 5 encerra aqui com essa pendência registrada; retomar
quando o usuário decidir sobre o upgrade de plano do Figma, ou quando
confirmar que o seat atual já basta pra tentar de novo com mais
cuidado com a cota.

---

## Decisões e bugs encontrados na Fase 6 (GitHub completo — Pull Requests)

Objetivo: `code.create_pull_request(project, title, description,
base_branch)`. Criar repositório, commit e push já existiam desde a
Fase 5 parte 1/3 — só faltava o próprio Pull Request. Pedido explícito
do usuário: só faz sentido dentro de um fluxo de BRANCH, diferente do
que já existia (que empurra direto pra main/master num projeto novo).

### Mudança de fluxo: branch obrigatória pra mudança em projeto já existente

`code.create_project` continua indo direto pra main/master, sem
branch, ao CRIAR um projeto novo — isso não muda. Mas ao fazer uma
MUDANÇA num projeto JÁ EXISTENTE, o fluxo vira: `code.git_create_branch`
(nova tool, BAIXO risco — cria e troca pra uma branch local, não toca
main/master nem o remoto, aditiva e reversível igual `git_commit`) →
escreve/commita já nessa branch → `code.create_pull_request` (ALTO
risco, mesmo nível de `git_push` — na prática É um `git_push` de uma
branch, feito por dentro da própria tool, antes de abrir o PR).
Nenhuma tool nova decide sozinha ISSO é projeto novo ou mudança
existente — só a intenção do pedido em si diferencia os dois casos, e
isso não dá pra derivar da assinatura de nenhuma tool. Resolvido com
uma regra sempre injetada no `systemPrompt` (`GIT_WORKFLOW_POLICY_TEXT`
em `packages/core/src/index.ts`), mesmo mecanismo já usado pra
`BASE44_POLICY_TEXT` (Fase 5 parte 2/3).

### Risco: `create_pull_request` fica FORA de `LOW_RISK_TOOLS`, de propósito

Mesma classificação de `git_push`, sem exceção — abrir um PR envolve
dar push de uma branch de verdade pro GitHub, mesma trava. Documentado
com o mesmo formato de comentário explicativo já usado pra `git_push`
em `packages/permissions/src/index.ts`. `formatConfirmationInput`
(`packages/core/src/index.ts`) ganhou um preview dedicado — mostra
projeto/título/base/descrição ANTES de pedir confirmação, em vez do
JSON cru, mesmo padrão de `git_push`/`send_draft`/Base44.

### Fora de escopo, DE PROPÓSITO: merge do PR

Não existe (e não deve existir sem pedido explícito) nenhuma tool de
merge. `create_pull_request` só ABRE — o PR fica esperando o usuário
revisar e mesclar ele mesmo pelo GitHub. Reforçado em três lugares:
description da tool, `GIT_WORKFLOW_POLICY_TEXT` no `systemPrompt`, e o
próprio texto de sucesso que a tool devolve.

Deploy de sites continua fora do escopo da SARAH, como já decidido —
usuário resolve manualmente (ver Roadmap). Só confirmado aqui pra não
parecer esquecimento: nenhuma mudança nesta fase abre esse escopo.

### Achado real, evitado ANTES de implementar: `main` vs `master` — os repositórios deste projeto usam os dois nomes, inconsistentemente

Checando o estado real dos repositórios existentes (`GET /repos/:owner/:repo`
via API, não assumido) antes de decidir um valor padrão pra
`base_branch`: repositórios criados por `code.create_project` recebem
`default_branch: "main"` do PRÓPRIO GitHub no instante da criação —
mesmo completamente vazios, sem nenhum commit — porque é o padrão do
GitHub pra repositório novo desde 2020. Mas o `git` LOCAL deste
ambiente não tem `init.defaultBranch` configurado, então todo `git
init` feito por `createProject` usa o nome clássico, `master`. Ou
seja: até o primeiro push de verdade, o GitHub "acha" que a branch
padrão é `main` (que não existe ainda), enquanto o repositório local
está em `master`. Assumir qualquer um dos dois nomes de cabeça no
código teria gerado PR contra uma branch errada silenciosamente (ou
uma falha confusa do GitHub, "base branch not found"). Corrigido
consultando a branch padrão REAL na hora (`getDefaultBranch`,
`packages/sandbox/src/github.ts`) quando `base_branch` não é passado
explicitamente pelo agente/usuário — nunca assumida.

### Validação — de ponta a ponta, com o Gateway/audit log/GitHub reais

Sem acesso direto pra digitar na janela do Electron a partir daqui:
validado chamando `createSarahSession` (a MESMA função que
`apps/cli`/`apps/menubar` usam, sem nenhum atalho/mock) com uma
implementação de `confirm` idêntica à do terminal real
(`apps/cli/src/main.ts`, `readline` + "(s/n)"), respondida com "s" de
verdade via stdin — ou seja, o MESMO Gateway, a MESMA classificação de
risco, o MESMO preview formatado, a MESMA exigência de confirmação
explícita antes de rodar, só que a resposta "s" veio de mim em vez de
um clique na janela.

Dois pedidos em linguagem natural, projeto real `social-post-community`
(reaberto, tinha 1 commit local nunca enviado — reusado exatamente
como "projeto já existente" pedido pela validação):

1. Pedido pra mudar o rodapé do `index.html` (adicionar o ano 2026 na
   linha de copyright) — o agente checou o arquivo ANTES de editar,
   viu que o ano já estava lá, e **recusou abrir um PR vazio**,
   perguntando se o pedido era outra coisa — comportamento correto,
   não um bug.
2. Pedido pra adicionar um `<span>Feito com a SARAH.</span>` no
   rodapé — o agente seguiu o fluxo certo sozinho, sem eu dizer o nome
   de nenhuma tool: `git_create_branch` (branch
   `feature/rodape-feito-com-sarah`, baixo risco, sem confirmação) →
   `write_file` + `git_commit` na branch (baixo risco) →
   `create_pull_request` (ALTO risco — Gateway pediu confirmação de
   verdade, mostrando projeto/título/base/descrição exatamente como
   `formatConfirmationInput` formata) → confirmado com "s" → PR aberto
   de verdade: **https://github.com/ParisPS/social-post-community/pull/2**,
   `feature/rodape-feito-com-sarah` → `master`, sem merge nenhum.

Achado extra durante a validação (não um bug de código, um artefato do
próprio processo de teste): uma tentativa anterior, que eu achava
travada (sem nenhuma saída por vários minutos) e interrompi, na
verdade tinha COMPLETADO de verdade em segundo plano — a causa da
"sem saída" era um `| tail -250` no comando de teste, que só imprime
depois que o processo de origem termina (não é um bug do projeto, é
como `tail -N` funciona sem `-f`). Resultado: essa tentativa também
abriu um PR real —
**https://github.com/ParisPS/social-post-community/pull/1** (branch
`chore/footer-copyright-2026` → `master`) — prova adicional,
independente, de que o fluxo completo (branch → commit → push →
abrir PR, sem merge) funciona de ponta a ponta. Os dois PRs ficam
abertos no repositório real do usuário, esperando revisão/merge manual
dele — nenhum dos dois foi mesclado ou fechado por mim.

---

## Fase 6 — completa

`code.create_pull_request` fecha o pedaço que faltava do GitHub
(criar repositório, commit e push já existiam desde a Fase 5). Fluxo
de branch obrigatório pra mudança em projeto já existente
(`code.git_create_branch`, baixo risco) — criação de projeto novo
continua indo direto pra main/master, sem branch, isso não mudou.
`create_pull_request` é ALTO risco sempre, mesmo nível de `git_push`
(é um `git_push` por dentro, antes de abrir o PR) — fora de
`LOW_RISK_TOOLS` de propósito, com preview dedicado mostrando
projeto/título/base/descrição antes da confirmação. Merge fica FORA
do escopo de propósito — sem tool própria, sempre manual pelo GitHub.
Deploy de sites confirmado como continuando fora do escopo, decisão já
tomada antes, não reaberta aqui.

Achado real evitado antes de implementar (não assumido): repositórios
deste ambiente têm `default_branch: "main"` no GitHub desde a criação
(mesmo vazios), mas o `git` local usa `master` (sem
`init.defaultBranch` configurado) — os dois nomes coexistem
inconsistentemente até o primeiro push de verdade. Resolvido
consultando a branch padrão real via API quando não especificada,
nunca assumindo `main` nem `master` de cabeça.

**Validado de ponta a ponta**, com o Gateway/audit log/GitHub reais
(via `createSarahSession`, a mesma função usada por
`apps/cli`/`apps/menubar`, sem mock): dois Pull Requests abertos de
verdade contra um projeto já existente do usuário
(`social-post-community` #1 e #2) — branch criada antes de qualquer
commit (nunca direto na main/master), confirmação de alto risco
exercida de verdade antes do push, PR aparecendo no GitHub, e nenhum
merge automático em nenhum dos dois casos.

---

## Decisões e bugs encontrados na Fase 4 (Voz), primeira etapa — capacidade de áudio isolada (STT+TTS)

Objetivo desta etapa, pedido explícito do usuário: só validar que
STT (entender fala) e TTS (falar) FUNCIONAM DE VERDADE nesta máquina,
isolados — mesmo padrão já usado pra Electron/Podman (testar a
capacidade crua antes de integrar na interface). **NADA foi integrado
em `apps/menubar`/`apps/cli` nesta etapa** — isso é a próxima, só
depois de STT/TTS provarem funcionar isolados, o que aconteceu aqui.

### STT: whisper.cpp via Homebrew — viável, modelo MULTILÍNGUE

`brew install whisper-cpp` instala vários binários (`whisper-cli`,
`whisper-stream`, `whisper-server`, etc.), com suporte a Metal/GPU
nativo (confirmado no log: `GPU name: Apple M1`, backend MTL0 em uso).
Modelos NÃO vêm junto — baixados à parte. Usado
`ggml-small.bin` (multilíngue, ~487MB, NÃO o `.en`-only) — pedido
explícito do usuário, já que o requisito é entender português E
inglês com detecção automática do idioma (`-l auto`), o usuário nunca
escolhe idioma de entrada.

**Bug real encontrado ANTES de sequer poder instalar**: o Homebrew
desta máquina estava em 4.2.17, e `brew info`/`brew install` falhavam
com `unknown or unsupported macOS version: "26.5.1"` — o próprio
Homebrew não reconhecia essa versão do macOS. Corrigido com `brew
update` (pulou pra 6.0.17, aí sim reconheceu 26.5.1). Sem isso, nada
do resto desta etapa teria funcionado — checado antes de assumir que
"Homebrew tá instalado" bastava.

### TTS: comando `say` nativo — vozes confirmadas de verdade, não assumidas

`say -v '?'` (aspas obrigatórias — sem elas o `?` vira glob do zsh e
falha com "no matches found") lista as vozes REALMENTE instaladas:

- **Luciana** (`pt_BR`) — confirmada, existe.
- **Samantha** (`en_US`) — confirmada, existe.
- **Nenhuma voz "Enhanced"/"Premium" está baixada nesta máquina** — a
  listagem completa de `say -v '?'` não mostra esse sufixo em nenhuma
  entrada. Baixar uma versão mais natural dessas vozes é possível via
  Configurações do Sistema → Acessibilidade → Conteúdo Falado (ou
  "Vozes", o nome exato pode variar por versão do macOS — não
  verificado independentemente pra este macOS 26.5.1 especificamente,
  não dá pra navegar Configurações do Sistema por aqui) → Gerenciar
  Vozes — passo manual do usuário, de propósito NÃO automatizado
  (pode ser um download grande, decisão dele).

### Achado real: gravar áudio de verdade via CLI no macOS não tem um caminho óbvio

Nenhuma ferramenta de gravação estava disponível (`sox`/`ffmpeg`
ausentes). `whisper-stream` (binário do próprio whisper-cpp, já tem
captura de mic embutida via SDL2 — parecia a opção óbvia) teve DOIS
problemas reais, descobertos testando, não hipotéticos:

1. **Dispositivo de captura padrão trava indefinidamente**: com
   `--capture -1` (padrão), o processo trava pra sempre em "attempt
   to open default capture device", sem erro, sem prompt visível, sem
   progresso — três dispositivos foram detectados (`iPhone de Paris
   Microphone`, `MacBook Air Microphone`, `Microsoft Teams Audio`), e
   o padrão escolhido (provavelmente o microfone de Continuidade do
   iPhone) nunca abre. Corrigido especificando o dispositivo real do
   Mac explicitamente (`-c 1`, "MacBook Air Microphone").
2. **`--save-audio` produz arquivo corrompido/silencioso se o
   processo for morto com SIGALRM** (usado inicialmente via `perl -e
   'alarm(N); exec(...)'`, já que o macOS não tem o comando `timeout`
   do GNU coreutils por padrão): o arquivo `.wav` saía com um cabeçalho
   válido de ~30s mas RMS zero (silêncio digital) — confirmado
   analisando as amostras com um script Python, não só "parecia
   estranho". Trocar pra `SIGINT` (via um processo `fork` + `kill`
   depois de um `select(undef,undef,undef,N)`, sem chamar `sleep`)
   fez o processo encerrar limpo, mas mesmo assim o buffer salvo tinha
   semântica de tempo confusa (áudio de verdade só nos ÚLTIMOS
   segundos de um arquivo de ~34s, resto silêncio) — não confiável
   pra capturar uma duração exata e previsível.

**Resolvido trocando pra `sox`/`rec`** (`brew install sox`, pacote
pequeno e comum, instalado sem pausar pra confirmar de novo — mesma
decisão já aprovada de "instalar ferramenta de áudio"): `rec -c 1 -r
16000 arquivo.wav`, encerrado com o MESMO padrão `fork` + `select` +
`kill("INT", ...)` — produz um `.wav` limpo, com duração EXATA e
previsível, confirmada por `soxi`. Detalhe real: o driver `coreaudio`
não aceita 16000Hz direto (loga um aviso e usa 44100 internamente),
mas o arquivo final sai resample para 16000Hz mono como pedido — sem
intervenção manual.

**Runbook validado pra gravar N segundos de áudio real por CLI nesta
máquina** (referência pra quando a integração de verdade acontecer):

```
perl -e '
  $pid = fork();
  if ($pid == 0) { exec(@ARGV) or die; }
  else { select(undef,undef,undef, N); kill("INT", $pid); waitpid($pid, 0); }
' -- rec -c 1 -r 16000 arquivo.wav
```

### Validação — áudio REAL gravado ao vivo pelo usuário, não sintetizado

Duas tentativas iniciais falharam por motivo de PROCESSO, não de
código — documentado pra não repetir: a primeira gravação capturou
um trecho de um vídeo em espanhol que o usuário estava assistindo (ele
não tinha visto a mensagem a tempo de falar); a segunda saiu
`[BLANK_AUDIO]` (RMS baixo e constante, sem padrão de fala — a janela
de 6-7s não foi suficiente pra sincronizar aviso-por-texto com fala
ao vivo). Corrigido aumentando a janela pra ~14s e confirmando com o
usuário o que tinha acontecido (`AskUserQuestion`) antes de tentar nas
cegas de novo — achado de processo relevante pra quando a voz for
integrada de verdade na interface: vai precisar de um sinal
claro/imediato de "SARAH está ouvindo agora" (ex.: indicação visual no
holograma), não só uma mensagem de texto, porque o atraso entre "ler a
mensagem" e "começar a falar" é real e variável.

Com 14s de janela, as duas gravações reais funcionaram:

- **Português**: usuário falou "Hoje é um dia ensolarado e eu gosto
  de programar." — RMS mostrou o padrão de fala claro (picos de
  400-800 a partir do segundo 4, contra ruído de base ~25). Transcrito
  como **`pt` (confiança 96,9%)**: *"Hoje é um dia ensolarado e eu
  gosto de programar."* — bate PALAVRA POR PALAVRA com o que foi
  falado.
- **Inglês**: usuário falou "The weather today is sunny and I really
  enjoy programming." — RMS confirma fala real desde o segundo 1.
  Transcrito como **`en` (confiança 72,9%)**: o texto pedido aparece
  correto, repetido algumas vezes (o usuário repetiu a frase durante a
  janela mais longa, não é bug de transcrição).

### Validação do TTS — tocado ao vivo E verificado objetivamente por round-trip

`say -v Luciana "..."` e `say -v Samantha "..."` tocados ao vivo pros
alto-falantes do Mac. Verificação OBJETIVA, não só "achei que soou
bem": gerado o áudio de cada um em arquivo (`say -v <voz> -o
arquivo.wav --data-format=LEI16@22050 "..."` — achado real: esse
`--data-format` só funciona com saída `.wav`, com `.aiff` falha com
"Opening output file failed: fmt?") e retranscrito com o MESMO
`whisper-cli`/modelo `small`:

- Luciana (pt_BR): auto-detectado **`pt`, confiança 90,9%** — texto
  transcrito bate quase exato com o original (só a grafia de "SARAH"
  saiu como "Sara", esperado — é a pronúncia sendo interpretada pelo
  STT, não um defeito do TTS).
- Samantha (en_US): auto-detectado **`en`, confiança 99,1%** — texto
  bate quase exato ("Sarah" em vez de "SARAH", mesmo motivo).

### Comportamento confirmado com o usuário, pra quando integrar

Toda resposta é falada em voz alta, MESMO quando o pedido foi
digitado (não só quando veio por voz) — decisão confirmada
explicitamente antes de implementar, registrada aqui pra não virar
suposição na hora de integrar.

### Conclusão desta etapa

STT (whisper.cpp, modelo multilíngue `small`, detecção automática de
idioma) e TTS (`say`, vozes Luciana/Samantha) **provados viáveis nesta
máquina com áudio real** — gravação ao vivo transcrita corretamente
nos dois idiomas, TTS validado tanto ao vivo quanto por round-trip
objetivo. `apps/menubar`/`apps/cli` **NÃO foram tocados** — integração
(captura de mic pela interface, indicador visual de "ouvindo",
reprodução da resposta falada) é a PRÓXIMA etapa, de propósito fora do
escopo desta.

---

## Decisões e bugs encontrados na Fase 4 (Voz), segunda etapa — integração na interface

Depois de STT/TTS validados isolados (etapa anterior), esta etapa
integra tudo em `apps/menubar` — em dois pedidos consecutivos do
usuário (integração inicial, depois um segundo ajuste depois de ver a
primeira versão rodando). Documentados juntos aqui porque nenhum dos
dois tinha sido commitado ainda quando o segundo chegou.

### Onde a voz roda: processo principal do Electron, nunca no daemon

`@sarah/voice` (novo pacote — wrappers finos sobre `whisper-cli`
(STT), `say` (TTS) e `sox`/`rec` (gravação, efeito `silence` embutido
pra parar sozinho, `SIGINT` — não `SIGKILL`/`SIGALRM` — pra parar
manualmente sem corromper o `.wav`, achado já registrado na etapa
anterior) roda inteiro no processo do Electron (`main-process.ts`),
nunca no daemon filho que carrega `@sarah/core`. Decisão consciente:
gravação/reprodução de voz é plumbing de UI local, não uma tool que o
AGENTE decide chamar — não faz sentido passar pelo Gateway
(`@sarah/permissions`), que existe pra governar decisões do modelo,
não interação direta do usuário com a interface. Mesmo raciocínio já
usado pro dialog nativo de confirmação (`confirmViaDialog`).

### Composição: esfera dominante, conversa migrou pro Histórico

A lista de mensagens que ocupava a janela principal saiu de lá —
migrou pro painel de histórico (`history.html`), que ganhou uma seção
de conversa (bolhas + selo de tool, mesmo `tool-meta.js` compartilhado
com a janela principal pra não duplicar a tabela emoji/nome/animação
em dois lugares) além da tabela de decisões do Gateway que já tinha.
A janela principal ficou só com a esfera + dashboard + uma barra de
controles: botão de microfone sempre visível, campo de texto que só
expande quando o ícone de teclado é clicado (CSS `width`/`opacity`,
não uma segunda linha), e um toggle PT/EN.

### Gravação: dois IPC handlers, não um evento push

`sarah:startRecording` devolve na hora, assim que o processo `sox`
nasceu (não espera terminar). `sarah:awaitRecording` é uma chamada
SEPARADA que fica pendurada até a MESMA promise (`Recorder.finished`)
resolver — seja por silêncio detectado sozinho, seja por
`sarah:stopRecording` (clique de novo no microfone). Desenhado assim
de propósito: este projeto nunca usou `webContents.send` (evento
push) em nenhum outro lugar, só invoke/await — introduzir o primeiro
padrão push só pra isso quebraria a consistência sem necessidade real,
já que "esperar a gravação acabar" cabe perfeitamente num segundo
invoke que só resolve mais tarde.

### Idioma de saída independente do idioma falado

O toggle PT/EN na interface escolhe a VOZ (Luciana/Samantha) que fala
a resposta — sempre independente do idioma que o usuário falou/digitou
pra SARAH, que o STT detecta sozinho (`whisper-cli`, modelo
multilíngue). Comportamento confirmado explicitamente com o usuário
antes de implementar. Toda resposta é falada em voz alta, mesmo quando
o pedido veio digitado — mesma decisão já registrada na etapa
anterior, agora implementada de verdade em `renderer.js`
(`sendPrompt`, único fluxo compartilhado por texto E voz).

### Estado "ouvindo" na esfera: cor discreta, não um nível de energia

`hologram.js` já tinha "idle"/"thinking" controlados por
`targetEnergy` (energia contínua, cor desliza de um tom pro outro).
"Ouvindo" precisava ser visualmente DISTINTO, não só mais um nível de
energia no meio do caminho — implementado como uma cor própria
(`COLOR_NODE_LISTENING`, verde-azulado, não confundir com o azul de
"pensando" nem o laranja já usado pra risco alto) que tem prioridade
sobre o gradiente idle↔thinking sempre que `currentState ===
"listening"`, com uma energia fixa de 0.45 (entre o repouso de idle e
o pico de thinking) só pro pulso ficar um pouco mais vivo, sem
competir com o nível reservado pra "processando de verdade".

### Validação da integração completa — testada de ponta a ponta pelo usuário

Sem acesso a clicar na janela do Electron a partir daqui — pedido ao
usuário pra testar com o app aberto de verdade:

- Layout novo (esfera dominante, sem lista de mensagens, campo de
  texto minimizado) confirmado visualmente.
- Ícone de microfone e widget de status (ver abaixo) confirmados
  visualmente.
- **Microfone de ponta a ponta, nos dois idiomas**: clique no
  microfone, fala real em português E em inglês, SARAH entendeu os
  dois (STT auto-detectando), respondeu, e falou a resposta na voz
  certa pro idioma marcado no toggle da interface — confirmado
  funcionando pelo usuário.

---

## Decisões e bugs encontrados na Fase 4 (Voz), segunda etapa — ajuste 2 (composição, links, widget de status)

Depois de ver a primeira versão da integração rodando, o usuário
pediu um segundo ajuste, ainda dentro da mesma etapa (nada disso tinha
sido commitado ainda): a composição sobrava um vazio grande entre o
dashboard e os controles; a área de legenda não tinha propósito real;
os ícones ainda eram emoji; faltava um widget discreto de contexto
(data/hora/clima/localização).

### Layout: dashboard cresce pra preencher a janela (`flex: 1` em cascata)

`#top` (esfera + os 4 painéis) virou `flex: 1` dentro da coluna do
`body`, ocupando toda a altura disponível até a barra de legenda —
antes ficava com altura fixa (a esfera tinha `height: 440px` fixo),
sobrando uma faixa preta vazia entre o dashboard e os controles do
rodapé. Os `.panel` (cartões) também viraram `flex: 1` dentro da sua
coluna, então crescem junto — o conteúdo de cada um fica centralizado
verticalmente (`.panel .body { justify-content: center }`), exceto o
gráfico de atividade (`#activity-chart`), que faz mais sentido
esticar de verdade pra preencher o espaço extra (o SVG já usava
`preserveAspectRatio="none"` desde a Fase 4 parte 4 — só faltava a CSS
não travar a altura renderizada em 46px fixos).

### Legenda com link clicável: ganha um propósito, deixa de ser um vazio

A área abaixo da esfera (`#stage`), que antes só mostrava um texto de
dica fixo, passou a mostrar o estado passageiro ("🎙 ouvindo...", "💭
pensando...") e, depois de cada resposta, o TEXTO da resposta — e,
quando ela contém uma URL ou um caminho de arquivo absoluto real (ex.:
um SVG que `graphics.create_svg` acabou de salvar em
`~/SarahProjects/<projeto>/assets/...`), um botão/chip clicável que
abre o link/arquivo via `shell.openExternal`/`shell.openPath`
(`sarah:openLink`, novo handler IPC — mesma camada de UI local que a
voz, não passa pelo Gateway: é o usuário clicando num resultado que a
SARAH já produziu, não uma decisão nova do agente).

**Bug real encontrado testando com o usuário**: o chip aparecia mas o
clique não abria nada, sem erro visível nenhum. Causa: a extração do
link usava uma regex que só excluía espaço, aspas e parênteses do
final do caminho — mas as respostas da SARAH costumam envolver
caminhos de arquivo em markdown (`` `/Users/.../arquivo.svg` ``), e a
crase do fim ficava colada no "link" extraído, fazendo
`shell.openPath` procurar um arquivo que não existe (o caminho real
mais um caractere a mais). Corrigido excluindo crase e asterisco do
conjunto de caracteres aceitos na regex, e revalidado — o chip abriu o
arquivo de verdade depois da correção. Corrigido também o
silenciamento em si: antes o clique não checava o resultado da
`ipcMain.handle`; agora, se `openLink` falhar, o próprio chip mostra a
mensagem de erro por alguns segundos antes de voltar ao normal — pra
uma falha futura (arquivo apagado, permissão negada) nunca mais ficar
muda.

### Widget de status: hora/data sempre, clima/localização quando autorizado

Canto discreto da janela (`#status-widget`), sem competir com a
esfera. Hora/data não dependem de rede nem permissão nenhuma
(`Date`/`toLocaleTimeString`, atualizado a cada 15s). Clima e
localização dependem de duas coisas:

- **Localização**: `navigator.geolocation.getCurrentPosition` no
  renderer — API do PRÓPRIO Chromium, não um `fetch` (por isso não
  esbarra na CSP `default-src 'self'` da janela). No macOS, o
  Chromium usa o Core Location do sistema por baixo — MESMA categoria
  de permissão (Ajustes > Privacidade e Segurança > Serviços de
  Localização) já usada pra Calendar/Reminders/Notes nas fases
  anteriores, só que disparada pelo próprio processo do Electron em
  vez de um `osascript` filho (não existe bridge JXA pra localização
  como existe pro EventKit). Precisou de um passo a mais que os
  outros: o Electron NEGA toda permissão do Chromium por padrão
  quando não há `setPermissionRequestHandler` registrado — adicionado
  em `main-process.ts`, liberando explicitamente só `geolocation` (e
  mais nada — este app nunca usa câmera/microfone via `getUserMedia`,
  a gravação de voz é `sox`/`rec` via `child_process`).
- **Clima**: API pública da Open-Meteo (`/v1/forecast?...&current=
  temperature_2m,weather_code`), sem chave pra uso não-comercial —
  conferido na documentação atual antes de implementar, como pedido
  explicitamente (não assumido de memória). Código WMO traduzido pra
  uma descrição curta em português (tabela pequena, só as faixas mais
  comuns).
- **Geocodificação reversa** (coordenadas → cidade/país, pro texto do
  widget, já que a Open-Meteo não devolve isso): API client-side
  gratuita da BigDataCloud (`api-bdc.net/data/reverse-geocode-client`),
  também sem chave — igualmente conferida na documentação atual antes
  de usar (a URL correta é `api-bdc.net`, não `api.bigdatacloud.net`
  como a memória do modelo sugeriria de cabeça).

As duas chamadas de rede (clima + geocodificação reversa) rodam no
PROCESSO PRINCIPAL (`sarah:weather`, novo handler IPC), nunca no
renderer — reforça a mesma regra já seguida em todo o app: a CSP da
janela (`default-src 'self'`) nunca precisou ganhar um `connect-src`
liberado pra host nenhum externo, porque o renderer só pede as
COORDENADAS (API do navegador) e delega a busca de verdade pro
processo principal, que já tem acesso de rede irrestrito.

### Ícones: emoji trocado por SVG monocromático

🎤/⌨️ trocados por SVG inline com `stroke="currentColor"` — mesmo
traço/paleta dos glifos de tarefa que já reagiam no núcleo da esfera
desde a Fase 4 parte 4. Vantagem prática, não só estética: com
`currentColor`, o estado "gravando" do microfone (que já mudava a cor
do botão pra vermelho) recolore o ícone automaticamente, sem precisar
de um SVG alternativo pro estado ativo.

### Validação — de ponta a ponta, com o usuário

Sem acesso a clicar na janela a partir daqui: cada item pedido
validado separadamente pelo usuário rodando o app de verdade —
composição sem espaço vazio (esfera+cards preenchendo até perto do
rodapé); ícones SVG e widget de data/hora/clima/localização (incluindo
o popup de permissão de Localização do macOS) aparecendo certos; link
clicável funcionando de ponta a ponta DEPOIS do bug da crase corrigido
(pedido de criar um SVG via `graphics.create_svg`, chip aparecendo na
legenda, clique abrindo o arquivo de verdade); e, revisitando a
validação da etapa anterior que ainda não tinha sido feita, o
microfone de ponta a ponta nos dois idiomas (português e inglês),
confirmado funcionando pelo usuário.

**Fase 4 (Voz) está completa — as duas etapas.**

---

## Decisões e bugs encontrados na Fase 4 (Voz), segunda etapa — ajuste 3 (mockup de referência, donut de risco, geolocalização por IP)

Depois do ajuste 2, o usuário enviou um mockup visual de referência
(imagem) com ajustes pontuais de composição/estilo do dashboard —
tratados aqui, ainda dentro da mesma etapa (nada disso tinha sido
commitado ainda).

### Cards de conteúdo curto não devem esticar — `flex: 1` era a ferramenta errada pro problema errado

O ajuste anterior (eliminar o vazio entre o dashboard e o rodapé)
tinha feito TODO `.panel` usar `flex: 1`, dividindo a altura da coluna
em partes iguais. Isso resolvia o vazio no nível de `#top` (container
inteiro), mas criava um problema novo e diferente, só visível
comparando com o mockup: cards com pouco conteúdo (Integrações, Risco)
ficavam enormes, com espaço vazio DENTRO deles mesmos. Corrigido
separando as duas responsabilidades: `#top` continua `flex: 1` (ocupa
a janela inteira — isso não mudou), mas `.panel` voltou a ter altura
de CONTEÚDO (`flex: 0 0 auto`), e é a `.dash-col` que centraliza o par
de cards no meio do espaço da coluna (`justify-content: center`) — o
fundo gradiente do próprio `#top` preenche qualquer sobra ao redor,
então nunca mais volta a parecer um vazio "quebrado" (é parte da
composição, não um bug).

### Card de atividade: `height: 100%` também foi revertido

Pelo mesmo motivo simétrico: o ajuste anterior esticava
`#activity-chart` (`height: 100%`) pra preencher o painel inteiro —
mas com o painel tendo `flex: 1`, isso fazia esse card específico
crescer desproporcionalmente em relação aos outros três. Voltou a ter
altura fixa e compacta (`height: 54px`), igual aos outros cards do
mockup.

### Gráfico de risco: donut real via `stroke-dasharray`, sem lib nova

A barra horizontal (`#risk-bar`, dois `<div>` com `width` em %) virou
um donut de verdade — duas `<circle>` SVG concêntricas, cada uma com
`stroke-dasharray`/`stroke-dashoffset` representando a fração exata do
círculo que aquele risco ocupa, giradas com um `<g transform="rotate(-90 ...)">`
pra começar às 12h (leitura padrão de gráfico de pizza/donut) em vez
de às 3h (onde um `<circle>` sem rotação começa a desenhar por
padrão). Um `gap` pequeno (5 unidades de um total de ~251, só quando
os dois segmentos existem de verdade) encurta cada arco e abre um
respiro visual entre eles, com `stroke-linecap: round` arredondando as
pontas — mesmo efeito do mockup. Texto centralizado por cima
(`position: absolute` dentro de um wrapper `position: relative`)
mostra a porcentagem de risco BAIXO em destaque + o rótulo "baixo
risco" abaixo, e uma legenda com as duas cores (ciano/âmbar) fica
embaixo do donut. Tamanho aumentado de 92px pra 122px depois de um
segundo retoque pedido pelo usuário — no tamanho original a
porcentagem central ficava visualmente comprimida.

### Emojis removidos das listas (integrações e categorias)

Pedido explícito do usuário comparando com o mockup, que usa só texto
+ indicador de cor — o mapa `ICONS` (emoji por integração) foi
removido de `dashboard.js`, sem substituto (não é ícone SVG no lugar,
é ausência mesmo, igual ao mockup). Aplicado tanto no painel de
Status das Integrações quanto no de Atividade por Categoria, mesmo o
pedido original mencionando só o primeiro — o mockup também não tem
emoji nas categorias, então manter ali seria uma inconsistência nova.

### Indicador "configurado": verde genérico trocado pela cor de acento

A bolinha de status de cada integração usava um verde solto
(`#4ade80`) fora da paleta do resto da interface — trocada pela MESMA
cor de acento usada na esfera e nos outros destaques (`--accent-bright`),
com um brilho sutil (`box-shadow` reaproveitando `--accent-glow`, que
já tinha exatamente o mesmo RGB do acento).

### Achado real, investigado a fundo: `navigator.geolocation` tem um bug antigo e não resolvido no Electron

O widget de status (clima/localização) tinha sido implementado no
ajuste anterior via `navigator.geolocation.getCurrentPosition` no
renderer — a permissão de Localização do macOS era concedida sem
problema (nenhum popup reaparecia depois da primeira vez), mas a
chamada em si falhava sempre com `GeolocationPositionError: Timeout
expired` (código 3), mesmo aumentando o timeout de 10s pra 25s.
Investigado com uma busca real (não assumido "deve ser lentidão"): é
um bug conhecido e antigo do Electron, com issues abertas há anos sem
correção definitiva (`github.com/electron/electron/issues/28443`,
entre outras com o mesmo sintoma exato) — o provedor de localização
por REDE do Chromium (usado mesmo em desktop, inclusive macOS com Core
Location por baixo) exige uma `GOOGLE_API_KEY` configurada, que é um
produto PAGO do Google Cloud (billing ativado) além da cota gratuita.
Sem essa chave, falha nesse mesmo erro, mesmo com a permissão do
sistema concedida.

Apresentado ao usuário como uma decisão real, não resolvido sozinho
por trás das costas: três opções (trocar pra localização por IP sem
popup; configurar uma `GOOGLE_API_KEY` paga; ou remover clima/
localização do widget, ficando só com data/hora). Escolhida a
localização por IP — decisão explícita do usuário.

**Implementação nova**: `https://ipwho.is/` (sem parâmetro nenhum =
usa o IP público de quem chamou), sem chave, HTTPS, 1000
requisições/dia de cota gratuita (documentação atual conferida antes
de trocar) — devolve cidade/país E latitude/longitude num ÚNICO
request, o que também eliminou a necessidade da segunda chamada de
geocodificação reversa (BigDataCloud) que a versão anterior fazia: a
mesma resposta já tem tudo que a Open-Meteo precisa pro clima. O
handler `sarah:weather` não recebe mais nenhum argumento — antes
recebia coordenadas obtidas no renderer, agora resolve tudo sozinho no
processo principal. `navigator.geolocation` e o
`setPermissionRequestHandler` que liberava `geolocation` foram
removidos do código — nenhuma permissão de navegador é mais pedida por
este app.

### Validação — de ponta a ponta, comparando com o mockup a cada rodada

Sem acesso a clicar na janela a partir daqui: cada rodada de ajuste
testada separadamente pelo usuário comparando com a imagem de
referência, incluindo duas idas e voltas até acertar o tamanho dos
cards de pouco conteúdo e o tamanho do donut, e uma investigação real
(não só "tenta de novo") até a causa raiz do clima/localização não
aparecerem — confirmado funcionando depois da troca pra IP.
Conferência final, tela inteira comparada com o mockup: widget isolado
sem sobrepor nenhum card, os quatro cards do tamanho certo, donut de
risco legível com porcentagem central, sem emoji nas listas, indicador
na cor de acento, microfone destacado, e clima/localização aparecendo
— tudo confirmado pelo usuário.

---

## Decisões e bugs encontrados na Fase 4 (Voz), segunda etapa — ajuste 4 (três correções antes de fechar a fase)

Três bugs reais apontados pelo usuário depois de usar a interface por
um tempo, corrigidos antes de dar a Fase 4 (Voz) como encerrada.

### Bug 1: TTS soletrando URL/caminho/identificador longo, letra por letra

O texto da resposta ia pro `say` (`window.sarah.speak`) exatamente
como aparecia na tela — quando esse texto incluía uma URL, um caminho
de arquivo absoluto, ou qualquer token técnico longo sem espaço (hash
de commit, UUID, slug de projeto), o `say` não tem heurística nenhuma
pra isso e lia CARACTERE POR CARACTERE, sem sentido nenhum em voz
alta ("h, t, t, p, s, dois pontos, barra, barra, ..."). Corrigido com
uma etapa determinística de limpeza ANTES do TTS — mesmo princípio já
usado no projeto inteiro pra preferências/idioma (nunca depender do
modelo "lembrar" de fazer algo sozinho): `sanitizeForSpeech()`
(`renderer.js`) reusa os MESMOS padrões de URL/caminho já usados pro
link clicável (agora com flag global, pra trocar TODAS as ocorrências,
não só a primeira) mais um padrão novo pra qualquer outro token
técnico longo que sobrar (20+ caracteres sem espaço, contendo pelo
menos um dígito/`.`/`_`/`-` — heurística pra não confundir com uma
palavra grande legítima em português/inglês), substituindo cada
ocorrência por uma referência curta ("o link"/"o arquivo"/"um
identificador"). Duas versões do MESMO texto a partir daí: a que vai
pra tela (`showStageResponse`, original, link completo e clicável) e a
que vai pro `say` (sanitizada) — nunca a mesma string nos dois
lugares quando há link/caminho/id.

### Bug 2: toggle de idioma só trocava a VOZ, não o texto — causa raiz e correção

O toggle PT/EN de `apps/menubar` desde sempre só escolhia qual voz do
`say` falava a resposta (Luciana/Samantha) — mas nada dizia pro
MODELO em qual idioma escrever o TEXTO da resposta, que continuava
saindo no idioma que ele achasse mais natural (geralmente o idioma do
pedido). Resultado: pedir algo em português com o toggle em EN
produzia texto em português lido com pronúncia/sotaque de inglês —
sem sentido, porque o problema nunca foi a voz, foi o texto estar no
idioma errado pra começo de conversa.

Corrigido na camada certa: `packages/core/src/index.ts` ganhou
`OutputLanguage` (`"pt" | "en"`, exportado) e `ask()` passou a aceitar
um segundo parâmetro opcional `outputLanguage` — quando presente,
`buildOutputLanguageText()` monta uma instrução ("escreva sua resposta
final inteira em PORTUGUÊS/INGLÊS...") injetada no `systemPrompt` de
CADA chamada a `query()`, mesmo mecanismo já usado desde a Fase 2 pras
preferências (determinístico, sem cache, montado fresco a cada
`ask()` — nunca uma decisão que o modelo precisa lembrar sozinho).
`apps/cli` continua chamando `ask(prompt)` sem esse argumento — nada
muda pro terminal, que nunca teve um toggle de idioma; só
`apps/menubar` passa o valor do toggle, ponta a ponta:
`renderer.js` → `preload.cjs` → `sarah:ask` (`main-process.ts`) →
`sarah-daemon.ts` (bridge, no protocolo JSON Lines) → `daemon.ts`
(processo filho) → `session.ask(prompt, outputLanguage)`. Com essa
mudança, o TEXTO da resposta inteira sai no idioma escolhido — a voz
que lê ele depois (já correta antes) finalmente bate com o texto.

### Bug 3 (visual, simples): "SARAH" embaixo da esfera, pedido pra cima

`#hologram-label` tinha `bottom: 4px` — trocado por `top: 6px`, sem
mais mudança nenhuma (mesma fonte/cor/posição horizontal).

### Validação — de ponta a ponta, com o usuário

Sem acesso a clicar na janela a partir daqui: typecheck limpo em todos
os arquivos tocados (só o artefato pré-existente e já diagnosticado
`McpSdkServerConfigWithInstance`/duplicação de `zod` apareceu, mesma
assinatura de sempre) e três testes reais pedidos ao usuário,
confirmados um por um: (1) toggle em EN, pedido em português — TEXTO
da legenda E voz saíram em inglês de verdade, não só a voz lendo texto
em português; (2) pedido que gera um link/arquivo real — a fala
resumiu ("o link"/"o arquivo") em vez de soletrar, e a tela continuou
mostrando o link completo e clicável; (3) "SARAH" confirmado acima da
esfera.

**Fase 4 (Voz) fica encerrada aqui, com as três correções aplicadas e
validadas.**

---

## Decisões e bugs encontrados na Fase 7, parte 1 (memória semântica — embeddings)

Objetivo: `memory.recall` encontra memórias por SIGNIFICADO, não só
palavra-chave exata, e `memory.remember` detecta preferências/fatos
parecidos já guardados antes de empilhar silenciosamente uma
contradição — resolvendo, de propósito, as duas notas pendentes
registradas na Fase 2 (ver seção acima), sem abrir mão das garantias
que motivaram deixá-las pendentes na época.

### Fornecedor confirmado na documentação atual: Voyage AI, `voyage-4-lite`

Voyage AI é o parceiro que a própria Anthropic recomenda pra
embeddings (Claude não gera embedding nativamente). Endpoint e modelo
CONFERIDOS na documentação atual antes de escrever qualquer código, não
assumidos de memória: `POST https://api.voyageai.com/v1/embeddings`,
modelo `voyage-4-lite` (o mais barato da família `voyage-4` — 200M
tokens grátis por conta, de sobra pro volume de um assistente pessoal
de um usuário só; a qualidade maior de `voyage-4`/`voyage-4-large` não
se justifica pra frases curtas de fato/preferência), dimensão padrão
1024 (não sobrescrita, um parâmetro a menos pra errar). `input_type`
diferenciado (`"document"` ao gravar, `"query"` ao buscar em
`memory.recall`) segue a recomendação da própria Voyage pra melhorar
retrieval assimétrico — já a checagem de conflito (`findSimilar`)
compara memória-com-memória, o MESMO tipo de conteúdo dos dois lados,
por isso usa `"document"` nos dois lados ali, não `"query"`.

### Armazenamento: `sqlite-vec` confirmado viável, mas com ressalva real de maturidade

Mantém o padrão já usado neste projeto (um SQLite por
responsabilidade — `sarah.db`, `sarah-memory.db`) em vez de um banco
vetorial separado. A documentação oficial confirma que o projeto está
em **pré-v1** (`v0.1.10-alpha.4` no momento desta implementação,
"expect breaking changes" nas palavras da própria doc) — registrado
como decisão consciente de aceitar esse risco (projeto pessoal, baixo
volume), não ignorado. A extensão é carregada com `try/catch`
explícito (`sqliteVec.load(db)`); se falhar nesta máquina, um flag
`vecAvailable = false` faz TODA a camada de busca semântica degradar
silenciosamente pra "indisponível" — `memory.recall`/`memory.remember`
continuam funcionando normalmente, só com palavra-chave (FTS5), nunca
quebrando por causa de uma dependência experimental.

**Achados reais testando a extensão isoladamente antes de integrar nas
tools** (script descartável, não commitado):

- `INSERT INTO memories_vec(rowid, embedding) VALUES (?, ?)` EXIGE que
  `rowid` seja passado como `BigInt`, não `number` — um `number` comum
  falha com `SqliteError: Only integers are allows for primary key
  values on memories_vec` (erro de digitação da própria extensão,
  "allows" no lugar de "allowed" — confirmado que não é erro de digitação
  nosso).
- Consulta KNN (`WHERE embedding MATCH ? ... LIMIT N`) funciona sozinha
  contra a tabela virtual, mas **`k = N` e `LIMIT N` são mutuamente
  exclusivos** ("Only LIMIT or 'k =?' can be provided, not both") — e
  assim que a tabela virtual entra num JOIN com outra tabela (pra
  filtrar por `category`, por exemplo), o SQLite exige `k = N`
  explícito (não aceita mais `LIMIT` sozinho: "A LIMIT or 'k = ?'
  constraint is required on vec0 knn queries"). Resolvido fazendo o
  KNN numa SUBQUERY isolada (`SELECT rowid, distance FROM memories_vec
  WHERE embedding MATCH ? AND k = ?`) e só then fazendo o JOIN/filtro
  de categoria na query EXTERNA — padrão usado em `findSimilar` e
  `recall` (`db.ts`).
- A métrica padrão de distância é L2 (euclidiana), não cosseno — em
  vez de depender de `distance_metric=cosine` na definição da coluna
  (sintaxe que pode não existir/mudar entre versões alpha), os vetores
  são NORMALIZADOS (norma 1) antes de gravar (`normalize()`,
  `embeddings.ts`), e a distância L2 devolvida é convertida pra
  similaridade de cosseno por uma fórmula direta válida só pra vetores
  unitários: `‖a-b‖² = 2 - 2·cos(a,b) ⟹ cos(a,b) = 1 - ‖a-b‖²/2`
  (`l2DistanceToCosineSimilarity`). Verificado batendo essa fórmula
  contra um cosseno calculado na unha (produto escalar direto dos
  vetores normalizados) com embeddings REAIS da Voyage — os dois deram
  exatamente o mesmo número.

### `memory.recall`: fusão por Reciprocal Rank Fusion (RRF)

FTS5 (palavra-chave, BM25) e `sqlite-vec` (similaridade semântica)
rodam em paralelo; cada resultado ganha `1 / (60 + posição)` na lista
de origem (60 é a constante clássica da literatura de RRF, usada como
está, sem inventar um peso novo pra calibrar), e um id que aparece nas
DUAS listas soma as duas pontuações. Resolve um problema real de
combinar ranks: o "rank" do FTS5 (BM25) e a "distância" do `sqlite-vec`
vivem em escalas totalmente diferentes e incomparáveis — RRF ignora a
escala original, só usa a POSIÇÃO de cada resultado dentro da própria
lista, então nunca precisa de um fator de conversão arbitrário entre
os dois.

### Nota 1 da Fase 2 resolvida: teto CONSULTIVO, nunca filtro por relevância

Rejeitada de propósito a solução óbvia — filtrar preferências
injetadas por relevância semântica à mensagem atual quebraria a
garantia "preferência vale SEMPRE", que foi exatamente o motivo de não
resolver isso na Fase 2. `packages/core/src/index.ts` continua
injetando TODAS as preferências, sem filtro nenhum
(`memoryStore.listByCategory("preferencia")`, inalterado). Em vez
disso: `PREFERENCE_SOFT_CAP = 40` (`packages/memory/src/index.ts`) —
passar desse número nunca bloqueia nem filtra nada, só anexa um aviso
no resultado de `memory.remember` (`warning` no JSON devolvido) pro
agente repassar ao usuário sugerindo revisão/consolidação. Crescimento
fica visível e acionável, sem perder o determinismo que motivou a nota
original.

### Nota 2 da Fase 2 resolvida: checagem de conflito ANTES de gravar, com decisão do usuário

`memory.remember` busca por similaridade semântica contra memórias
JÁ EXISTENTES da MESMA categoria (fato-com-fato, preferência-com-
preferência) antes de gravar. Achar uma parecida acima de
`CONFLICT_SIMILARITY_THRESHOLD` interrompe a gravação — a tool devolve
`{conflict: true, existing: {...}, similarity}` em vez de salvar, e um
novo bloco sempre injetado no `systemPrompt`
(`MEMORY_CONFLICT_POLICY_TEXT`, `packages/core/src/index.ts` — mesmo
mecanismo de sempre-presente já usado pra `BASE44_POLICY_TEXT`/
`GIT_WORKFLOW_POLICY_TEXT`, reforçando o que a description da própria
tool já diz, porque description influencia mas não é garantida)
instrui o agente a perguntar ao usuário via `AskUserQuestion` antes de
decidir — SUBSTITUIR (memory.forget na antiga, que já era alto risco
desde a Fase 2, + `memory.remember` de novo com `force: true`) ou
MANTER AS DUAS (`memory.remember` com `force: true` direto).
`memory.remember` continua baixo risco sempre — só o `forget` de uma
eventual substituição passa pela confirmação de alto risco de sempre,
nada novo aí (mesmo padrão que o pedido original já antecipava).

**Threshold calibrado com embeddings REAIS, não com intuição
genérica**: a proposta inicial (0,84, baseada em expectativa comum
sobre embeddings) foi TESTADA contra o par de exemplo do próprio
pedido — "sempre crie lembretes na lista Trabalho" vs. "prefiro que
lembretes vão pra lista Pessoal" deu cosseno **0,72** com
`voyage-4-lite` (mesmo assunto, conclusão oposta — é um conflito de
verdade) — abaixo de 0,84, ou seja, a proposta original teria deixado
esse conflito passar batido. Medido também um par claramente NÃO
relacionado ("sempre crie lembretes na lista Trabalho" vs. "gosto de
café pela manhã"): cosseno **0,55**. `CONFLICT_SIMILARITY_THRESHOLD`
fechado em **0,68** — no meio dos dois pontos medidos, com folga maior
do lado de baixo (um falso positivo só custa uma pergunta a mais ao
usuário; um falso negativo deixa duas preferências contraditórias se
acumularem silenciosamente, exatamente o bug que esta fase resolve).

### Achado real: cota da Voyage sem cartão cadastrado (3 RPM) — e um bug real que ela expôs no backfill

A conta usada pra validar não tem cartão de pagamento cadastrado — a
própria API avisa isso no corpo do erro 429: **"reduced rate limits of
3 RPM and 10K TPM"** até adicionar um método de pagamento no painel da
Voyage. Não é um bloqueio (o código já degrada graciosamente pra
FTS5-only em qualquer falha de embedding, ver acima), mas é uma
limitação prática real: memórias muito antigas do usuário (7 no total,
de antes desta fase) precisam de embedding retroativo
(`backfillEmbeddings()`, chamado uma vez em background ao abrir a
store) — a primeira versão disparava essas chamadas em SEQUÊNCIA sem
pausa nenhuma, o que estourava a cota inteira sozinho e competia
DIRETAMENTE com a checagem de conflito de um `memory.remember` real do
usuário rodando ao mesmo tempo (reproduzido de verdade: um teste de
ponta a ponta falhou exatamente por isso). Corrigido com uma pausa de
20s entre cada embedding do backfill (`BACKFILL_DELAY_MS`, `db.ts`) —
não elimina o limite, mas evita que o PRÓPRIO backfill seja a causa de
uma checagem de conflito falhar logo depois de abrir o app. Registrado
pro usuário: cadastrar um cartão no painel da Voyage
(dashboard.voyageai.com) remove essa cota reduzida, se o uso real
mostrar que 3 RPM é limitante no dia a dia.

### Validação — de ponta a ponta, com embeddings e agente reais

1. **Matemática/mecanismo isolados**: `findSimilar` testado direto
   (sem passar pelo agente) com o par de exemplo do pedido — achou a
   memória "lista Trabalho" como candidata pra "lista Pessoal" com
   similaridade 0,72, acima do threshold 0,68; e corretamente NÃO achou
   nada pra um assunto não relacionado ("café de manhã", 0,55).
2. **Fluxo do agente real, via `createSarahSession`** (mesmo padrão de
   validação já usado nas Fases 5/6 — `confirm` que auto-aprova, pra
   testar o FLUXO sem exigir interação manual): pedido pra guardar uma
   preferência que já tinha uma memória quase idêntica salva disparou
   `memory.remember` → `conflict: true` → `AskUserQuestion` → Gateway
   pediu confirmação (mesmo "achado lateral" já documentado na Fase 2:
   `AskUserQuestion` também é alto risco) → aprovado, mas SEM seletor
   visual real conectado nesta interface (mesmo achado da Fase 5 parte
   2) → o agente reconheceu que não recebeu uma escolha capturada e,
   corretamente, NÃO salvou nem apagou nada sozinho, devolvendo a
   pergunta em texto pro usuário responder no próximo turno — nenhuma
   duplicata silenciosa aconteceu.
3. **Achado sobre o comportamento do modelo**: num segundo teste (pedir
   pra trocar "lista Trabalho" por "lista Pessoal", já sabendo por
   `memory.recall` que as duas existiam), o agente escolheu um caminho
   ALTERNATIVO válido — `memory.recall` (leitura) seguido de
   `memory.forget` direto na antiga, em vez de passar pelo `conflict`
   do `remember`. Continua seguro (o Gateway ainda exige confirmação
   de alto risco pra QUALQUER `forget`, then o usuário sempre tem a
   chance de negar), só é menos informativo que o fluxo desenhado (não
   mostra explicitamente "vou trocar X por Y, confirma?" antes de
   apagar) — registrado como uma segunda porta de entrada legítima pra
   a mesma garantia de segurança, não um bug a corrigir agora.
4. **Busca semântica com palavras diferentes**: `memory.recall` com a
   pergunta "em que período do dia costumo marcar meus encontros de
   trabalho?" (nenhuma palavra em comum com o texto guardado) encontrou
   corretamente, no topo dos resultados, as memórias reais do usuário
   "Prefere que reuniões sejam marcadas de manhã" — confirma a fusão
   FTS5+vetorial funcionando de ponta a ponta com dado real do usuário,
   não só dado sintético de teste.

**Achado lateral, não uma pendência desta fase**: os dados reais já
existentes do usuário (Fase 2) têm 3-4 registros quase idênticos sobre
"reuniões de manhã" — evidência concreta, no próprio banco de dados
real, do exato problema que esta fase resolve (guardados antes de
existir checagem de conflito nenhuma). Não removidos/consolidados por
esta implementação — decisão de limpar duplicatas JÁ EXISTENTES fica
com o usuário, não decidida sozinha aqui; a partir de agora, novas
tentativas de guardar algo parecido vão ser pega pela checagem nova.

## Correção pós-entrega na Fase 7, parte 1: `memory.forget` quebrava com `no such module: vec0`

Bug real encontrado pelo usuário rodando o app de verdade (não o
`createSarahSession()` isolado que validou a entrega original acima —
essa foi exatamente a lacuna: o processo REAL do usuário é
`apps/menubar/src/daemon.ts`, um processo filho de vida longa, spawnado
uma única vez por sessão do app via `tsx`/Node normal, ver "Parede real
#2" na Fase 4 — `better-sqlite3`/`sqlite-vec` nunca rodam dentro do
processo Electron em si). Tentar substituir a preferência "lista
Trabalho" pela "lista Pessoal" (o próprio par de exemplo usado na
validação original) falhou duas vezes seguidas com `no such module:
vec0` durante o `memory.forget` da antiga — e a linha **continuava**
em `memories` e `memories_fts` depois da falha, não só "faltando" em
`memories_vec`.

### Causa raiz: trigger SQL grava no ESQUEMA DO ARQUIVO, `vecAvailable` só vale por CONEXÃO

A implementação original sincronizava `memories_vec` num `DELETE` de
`memories` via um trigger SQL (`memories_vec_ad`), no mesmo espírito do
trigger de DELETE da FTS5 (que É necessário e correto — FTS5 é
embutido no SQLite, sempre disponível). A diferença crítica: um
trigger, uma vez criado, fica gravado no **esquema do arquivo `.db`**
pra sempre — não é "por conexão" como a flag `vecAvailable` (setada em
cada `new MemoryStore()`, dependendo se `sqlite-vec` conseguiu
carregar NAQUELA conexão). Sequência real que reproduz o bug: (1) uma
conexão anterior consegue carregar `sqlite-vec` com sucesso e cria o
trigger; (2) uma conexão POSTERIOR (nova sessão do app, ou a mesma
sessão depois de algo impedir o carregamento da extensão dessa vez —
não foi necessário isolar o motivo exato, ver próxima seção) tem
`vecAvailable = false`; (3) essa conexão chama `forget()`, que faz só
`DELETE FROM memories WHERE id = ?` — mas o SQLite ainda tenta EXECUTAR
o trigger `memories_vec_ad` incondicionalmente (triggers rodam no
motor SQL, não são algo que o código JS possa pular com um
`if (this.vecAvailable)` como as outras operações em `memories_vec`
já faziam) → falha com `no such module: vec0`, DENTRO da transação
implícita do próprio `DELETE` → a remoção inteira é desfeita, nem
`memories` nem `memories_fts` chegam a ser apagados.

**Confirmado direto no banco real antes de mexer em qualquer código**
(pedido explícito do usuário, não assumido): `SELECT id, category,
content FROM memories` mostrou id 13 ("lista Trabalho") E id 14
("lista Pessoal") ainda os dois presentes — a substituição realmente
nunca tinha acontecido. Reproduzido isoladamente com o `sqlite3` CLI
do sistema (que nunca carrega extensões): `SELECT rowid FROM
memories_vec` contra o banco real devolveu o mesmo erro `no such
module: vec0` — confirma que QUALQUER conexão sem a extensão
carregada, ao tocar `memories_vec` (direto ou via trigger), falha do
mesmo jeito.

Mesma CLASSE de bug já vista na Fase 2 (trigger de DELETE da FTS5
faltando → registro fantasma pesquisável) — mas invertido: lá faltava
um trigger necessário; aqui existe um trigger que depende de um módulo
OPCIONAL nem sempre disponível na conexão que o executa, e por isso
não pode ser a única forma de manter `memories_vec` sincronizada.

### Correção: limpeza de `memories_vec` vira código JS, nunca mais trigger SQL

Duas partes, as duas em `packages/memory/src/db.ts`:

1. **`forget(id)` passa a limpar `memories_vec` explicitamente em JS**,
   depois do `DELETE FROM memories` já confirmado, guardado por `if
   (this.vecAvailable)` (mesmo padrão de guarda já usado em
   `findSimilar`/`recall`/`tryEmbed`) e dentro de `try/catch` que nunca
   propaga — mesmo espírito best-effort do `tryEmbed`: a operação
   principal (apagar a memória) nunca pode ser bloqueada por uma falha
   na camada de busca semântica, que é opcional por design.
2. **Migração idempotente `DROP TRIGGER IF EXISTS memories_vec_ad`**,
   rodando incondicionalmente na inicialização de QUALQUER
   `MemoryStore` — inclusive ANTES de tentar carregar `sqlite-vec`,
   testado isoladamente que `DROP TRIGGER` não precisa do módulo vec0
   registrado nesta conexão. Sem isso, bancos como o de produção deste
   projeto (criados pela primeira versão desta fase) continuariam com
   o trigger legado pra sempre, e o bug voltaria a acontecer na próxima
   vez que uma conexão sem a extensão tentasse apagar algo.

Uma eventual linha órfã deixada em `memories_vec` (memória apagada numa
conexão sem a extensão carregada, então sem a limpeza em JS) nunca
aparece de volta em busca nenhuma: tanto `findSimilar` quanto `recall`
fazem `JOIN memories m ON m.id = v.rowid` — um INNER JOIN comum, que
descarta silenciosamente qualquer rowid de `memories_vec` sem linha
correspondente em `memories`. Não é preciso garantir 100% de limpeza
imediata pra manter a busca correta, só não deixar a limpeza bloquear
a operação principal — mesmo trade-off já aceito no resto desta fase.

### Validação da correção — três camadas, a última pelo caminho REAL de produção

1. **Mecanismo isolado, com a extensão deliberadamente quebrada**:
   renomeado temporariamente o `.dylib` do `sqlite-vec` (restaurado
   logo em seguida), instanciado `MemoryStore` contra uma CÓPIA do
   banco real (nunca o arquivo de verdade) — `vecAvailable` confirmado
   `false`, e `forget()` removeu a linha com sucesso, sem erro nenhum:
   reproduz e resolve o cenário exato do bug.
2. **Migração confirmada no banco real**: depois de rodar o código
   corrigido uma vez contra `data/sarah-memory.db`, `.schema` não lista
   mais nenhum trigger com "vec" no nome — o trigger legado que causava
   o problema foi removido de verdade, não só num teste isolado.
3. **Caminho de produção real, não `createSarahSession()` isolado**:
   um script spawnou `apps/menubar/src/daemon.ts` exatamente como
   `apps/menubar/src/sarah-daemon.ts` faz (mesmo binário `tsx`, mesmo
   protocolo JSON Lines via stdin/stdout, `confirm-request` auto-
   aprovado) — a mesma fronteira de processo que causou o bug original
   e que a validação anterior desta fase não tinha exercitado. Um par
   NOVO de preferências conflitantes (não "Trabalho"/"Pessoal", já
   usado antes): "sempre incluir previsão do tempo no resumo matinal"
   vs. "NÃO incluir, é redundante". Pedido pro agente resolver o
   conflito com `memory.forget` na antiga → **sem erro nenhum** desta
   vez. Conferido direto no banco depois: a antiga sumiu das TRÊS
   tabelas (`memories`, `memories_fts` E `memories_vec` — não só duas
   de três, que era exatamente o sintoma do bug original) e a nova
   permaneceu íntegra nas três.

**Achado lateral do próprio processo de teste**: um script de teste
meu, mal roteirizado (uma pergunta ambígua na terceira mensagem de uma
conversa com duas perguntas em aberto), fez o agente apagar por engano
a preferência REAL "lista Pessoal" do usuário (a que devia ter sido
mantida) em vez de uma memória de teste. Detectado imediatamente
comparando o estado do banco antes/depois de cada passo (mesma
disciplina usada no resto desta correção), e corrigido restaurando o
conteúdo original da memória (novo id, mesmo texto) antes de prosseguir
— nenhum dado real do usuário ficou perdido, mas registrado aqui como
lembrete de que testar contra o banco de produção real (necessário
pra validar o bug de verdade) exige o mesmo cuidado de qualquer
operação destrutiva contra dado real.

**Fase 7, parte 1 está completa — incluindo esta correção.**

## Decisões e bugs encontrados na Fase 7, parte 2, primeira peça (observabilidade — resultado real da execução)

Objetivo: até aqui, `tool_calls` (`@sarah/audit`) só gravava o que o
Gateway DECIDIU (`risk`/`decision`) — nunca se a tool, depois de
aprovada, funcionou de verdade. Uma chamada aprovada que falhasse por
erro de API/timeout/dado inválido ficava invisível no audit log, mesmo
tendo sido registrada como "auto-allow"/"confirmed".

### Proposta (aprovada antes de implementar): hooks `PostToolUse`/`PostToolUseFailure`, não o Gateway nem cada tool

`canUseTool` (o Gateway) só decide ANTES da tool rodar — nunca fica
sabendo se a execução em si funcionou, então não é o lugar certo.
Instrumentar cada tool individualmente (~20 tools em 8 pacotes)
duplicaria a mesma lógica em todo canto, contrariando o próprio
objetivo de observabilidade centralizada. O Agent SDK expõe hooks
`PostToolUse` (sucesso) e `PostToolUseFailure` (exceção não capturada)
que disparam automaticamente depois de QUALQUER tool rodar — nativa ou
MCP, não importa — com `tool_use_id`, `tool_response`/`error` prontos.
Esse é o ponto único de captura, sem tocar nas tools existentes.

Correlação com a linha que o Gateway já grava na decisão: o SDK já
passa um `toolUseID` pro terceiro argumento de `canUseTool` (confirmado
no `sdk.d.ts`, não assumido) — o MESMO id que os hooks devolvem como
`tool_use_id`. `packages/permissions` passou a repassar esse id pro
`onDecision`/`@sarah/audit`, que grava numa coluna nova (`tool_use_id`,
não pedida explicitamente no escopo original — avisado e aprovado antes
de implementar) só pra `recordResult()` conseguir achar a MESMA linha
depois, via `UPDATE ... WHERE tool_use_id = ?`.

### Migração idempotente — `PRAGMA table_info`, não `ADD COLUMN IF NOT EXISTS`

`ALTER TABLE ... ADD COLUMN IF NOT EXISTS` só existe a partir do SQLite
3.35 (2021); em vez de assumir a versão embutida no `better-sqlite3`
desta máquina, `AuditLog` confere via `PRAGMA table_info(tool_calls)`
(sempre disponível) e só adiciona as colunas (`tool_use_id`, `status`,
`error_message`) que realmente faltam — roda em todo `new AuditLog()`,
seguro mesmo depois que as colunas já existem. Linhas gravadas antes
desta fase ficam com `status = NULL` pra sempre: confirmado direto no
banco de produção, 259 linhas antigas preservadas com `status` vazio,
não é tratado como erro em lugar nenhum (`recentErrors()` filtra por
`status = 'error'` especificamente, nunca por `status IS NOT NULL`).

### Achado real testando: `PostToolUseFailure` quase nunca dispara neste projeto — a maioria dos "erros" está disfarçada de sucesso

Primeira validação real (Gmail `get_message` com um `messageId`
forjado, inexistente — API respondendo 400 de verdade) revelou algo
que a proposta original não previa: o painel "Erros recentes" continuou
vazio mesmo com um erro real acontecendo. Investigado direto (log de
debug temporário comparando os dois lados do hook, removido depois):
TODA tool deste projeto segue a mesma convenção — `try/catch` interno,
devolvendo `{ok: false, error: "..."}}` como texto NORMAL do resultado
(`content: [{type:"text", text: JSON...}]`), nunca lançando exceção nem
marcando `isError` no `CallToolResult` do MCP. É uma decisão de projeto
já existente, correta e deliberada (o agente precisa LER o erro pra
reagir na conversa, ex.: sugerir corrigir o e-mail) — não um bug a
corrigir nas tools. Consequência: do ponto de vista do protocolo MCP,
isso É um sucesso — `PostToolUse` dispara, não `PostToolUseFailure`.

Corrigido inspecionando o `tool_response` do PRÓPRIO `PostToolUse` pela
mesma convenção `{ok: false, error}` já usada em toda tool
(`extractToolError()`, `packages/core`) — continua um único ponto de
captura, sem duplicar nada em cada tool, só reconhece o formato que já
existia. Segundo achado, também via teste real: `tool_response` chega
como o ARRAY de blocos de conteúdo direto (`[{type:"text",...}]`), não
`{content: [...]}` como o `CallToolResult` cru do protocolo sugeriria —
`extractToolError` aceita as duas formas depois de confirmar qual é a
real, em vez de assumir uma só. `PostToolUseFailure` continua tratado
(pro raro caso de exceção de verdade não capturada), só deixou de ser
o caminho principal.

### Dashboard: painel "Erros recentes"

Mesmo padrão visual dos outros quatro cards (`apps/menubar/renderer`),
adicionado como terceiro painel da coluna direita (janela principal é
820×640, não a janela de histórico de 380×480 — espaço real sobra).
Lista vazia é o estado normal/esperado (a maioria das chamadas
funciona) — mensagem própria ("nenhum erro registrado"), não tratada
como "sem dado disponível" tipo os outros painéis quando ainda não há
uso algum.

### Validação — de ponta a ponta, pelo caminho de produção real (`daemon.ts` spawnado, não `createSarahSession()` isolado)

1. **Chamada bem-sucedida real**: "liste meus 2 e-mails mais recentes"
   → `mcp__sarah-gmail__list_recent_emails` rodou, resposta real da
   caixa de entrada do usuário devolvida → linha no audit log com
   `status = 'success'`, `error_message = NULL`.
2. **Erro real forçado**: `mcp__sarah-gmail__get_message` com um
   `messageId` forjado, inexistente → Gmail API respondeu 400 de
   verdade ("Invalid id value") → linha no audit log com
   `status = 'error'` e a mensagem REAL da API (não uma mensagem
   genérica inventada) em `error_message`.
3. **Painel do dashboard**: `dashboard().recentErrors` (mesma chamada
   que `apps/menubar` usa) devolveu exatamente essa falha, com
   `toolName`/`errorMessage` corretos — confirmado o dado chegando de
   ponta a ponta até onde o painel novo consome.
4. **Histórico preservado**: 259 linhas gravadas antes desta fase
   continuam com `status = NULL` no banco de produção real, sem
   nenhuma perda nem erro na migração.

Limpo depois da validação: um fato de teste próprio salvo em
`memory.remember` durante a investigação da correlação
(`tool_use_id`) — nenhum dado real do usuário tocado, mesma disciplina
das correções anteriores desta fase.

**Fase 7, parte 2 (primeira peça — resultado real da execução) está completa.**

## Investigação pós-entrega: `mcp__sarah-figma__export_assets` com `status`/`error_message` vazios — não era um bug de código

Achado do usuário: três chamadas reais a `export_assets` no audit log
de produção (incluindo uma feita DEPOIS do commit da correção acima)
apareciam com `status` e `error_message` vazios, apesar do rate limit
do Figma estar ativo (chamadas quase certamente falhando). Suspeita
levantada: talvez `export_assets` lance exceção (`throw`) no caminho
de rate limit em vez de devolver `{ok, error}` como o resto das tools,
e talvez `PostToolUseFailure` (o mecanismo original) tivesse sido
abandonado quando a correção anterior focou no `tool_response`.

### Respondendo às duas perguntas, com código e teste real — nenhuma das duas suspeitas se confirmou

1. **`export_assets` lança exceção no caminho de rate limit?** Sim,
   `fetchFigmaFile`/`exportImages` (`packages/sandbox/src/figma.ts`)
   fazem `throw new Error(...)` quando a resposta HTTP não é `ok`,
   incluindo o texto de `rateLimitInfo()` (Retry-After/tipo/plano). MAS
   esse `throw` acontece DENTRO do `try` que envolve o handler inteiro
   da tool (linhas 414-505) — o `catch` no fim converte pra
   `{content: [...{ok:false, error: err.message}]}`, exatamente a
   MESMA convenção que Gmail já usa. Do ponto de vista do protocolo
   MCP/SDK, isto é um sucesso (a tool rodou e devolveu uma resposta),
   não uma exceção não capturada — já coberto por `extractToolError()`
   desde a correção anterior, sem precisar de nenhuma mudança.
2. **`PostToolUseFailure` foi abandonado?** Não — conferido direto no
   código atual (`packages/core/src/index.ts`): `hooks: { PostToolUse:
   [{hooks:[onPostToolUse]}], PostToolUseFailure: [{hooks:[onPostToolUse]}]
   }` continua registrando os dois eventos pro mesmo handler. Nada foi
   removido; o mecanismo original continua ativo em paralelo ao novo,
   exatamente como desenhado (`PostToolUseFailure` cobre a exceção não
   capturada de verdade — rara, mas ainda tratada; `PostToolUse` +
   `extractToolError` cobre o `{ok,error}` "educado" — a maioria).

### Causa real: processo do daemon já rodando ANTES da correção, não código com bug

Testado de novo o `export_assets` pelo caminho de produção real
(`daemon.ts` recém-spawnado, mesmo protocolo de sempre) contra o
mesmo arquivo real usado na Fase 5 parte 6/7
(`teste-figma-dairy`/`QkiFeHLqU3WOgfiWassiXL`) — o rate limit
CONTINUAVA ativo (HTTP 429 de verdade, `Retry-After: 264339s`, tipo
"high", plano "starter") e desta vez o audit log capturou tudo
corretamente: `status = 'error'`, `error_message` com a mensagem REAL
da API incluindo os dados de rate limit, e visível em
`dashboard().recentErrors`. Ou seja, o código ATUAL funciona certo
pros dois casos — a pergunta virou "por que as três chamadas antigas
ficaram vazias, se o código já cobre isso?".

Resposta, confirmada olhando `apps/menubar/src/main-process.ts`: o
processo do daemon (`spawnSarahDaemon`) é criado UMA VEZ, quando o app
Electron abre (`daemon = spawnSarahDaemon(...)`, atribuído a uma
variável de módulo, reusado por TODA chamada de `ask()`/`dashboard()`
daquela sessão do app) — nunca respawnado por pedido. `tsx` carrega o
código-fonte só na hora que o processo NASCE; um processo já rodando
não passa a enxergar uma mudança de código feita no disco depois,
mesmo com `git pull`/commit novo. Se o app do usuário já estava aberto
quando a correção anterior foi commitada (bem provável: a terceira
chamada aconteceu só ~3 minutos depois do commit, tempo real
insuficiente pra imaginar um restart do app no meio), o daemon daquela
sessão continuou rodando a versão ANTERIOR do Gateway (sem
`toolUseId`) até o app ser fechado e reaberto — explica as três linhas
com `tool_use_id` NULO desde a inserção (confirmado direto no banco:
`tool_use_id IS NULL`, não uma string vazia), não só `status`/
`error_message` vazios por causa de alguma falha na correlação em si.

**Nenhuma mudança de código foi necessária** — o mecanismo já cobre os
dois casos corretamente. Lição registrada aqui pra não repetir a
mesma investigação: sempre que uma correção mexer em `packages/core`/
`packages/permissions` (código que roda dentro do daemon), o efeito só
vale pra sessões do `apps/menubar` abertas DEPOIS do commit — reiniciar
o app (ou usar `apps/cli`, que sobe um processo novo a cada `pnpm dev`)
é necessário pra observar a mudança de verdade.
