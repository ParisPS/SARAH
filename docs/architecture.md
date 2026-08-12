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
   tudo validado rodando de verdade. Falta só a voz, à parte.)**
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
   sobre a conta premium).)**
6. GitHub completo (commits, PRs) + deploy de sites.
7. Memória semântica (embeddings via Voyage AI) + observabilidade +
   nuance no risco médio.
8. Novas integrações e expansões.

## Próximo passo concreto

**Fase 3 está completa** (Apple Notes + ciclo inteiro de e-mail,
incluindo `send_draft`, validados rodando de verdade — detalhes na
seção acima).

**Fase 4 está completa até a parte 4** — resumo:

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

**Falta só a voz** — tratada desde o início como uma etapa
independente da interface gráfica, ainda não iniciada.

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
