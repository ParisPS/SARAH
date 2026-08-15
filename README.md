# SARAH — Fases 0-8 completas (Figma, Fase 5, com pendência de cota)

Assistente pessoal rodando localmente no Mac, construído com o Claude
Agent SDK: um Gateway de permissões baseado em risco na frente de
toda tool, log de auditoria em SQLite, e integrações reais com apps
do sistema e serviços externos. Cada fase é validada rodando de
verdade (não só revisão de código) — o histórico completo de decisões
e bugs reais encontrados está em [`docs/architecture.md`](docs/architecture.md).

## Fase 0 — fundação

- Gateway de permissões baseado em risco (`@sarah/permissions`):
  toda tool passa por `canUseTool` antes de rodar, nunca por
  `allowedTools` (pré-aprovar ali pula o Gateway — bug real
  encontrado e corrigido nesta fase).
- Log de auditoria em SQLite (`@sarah/audit`) — toda decisão do
  Gateway (auto-allow/confirmado/negado) fica gravada em
  `data/sarah.db`.
- Tools de teste (`ping`/`pretend_delete`) como sanity check dos dois
  caminhos (baixo risco roda direto; alto risco pede confirmação
  `(s/n)`).
- **Decisão mais importante:** risco não vive dentro da tool — uma
  política central classifica `low`/`high` e decide se confirma;
  tool desconhecida é alto risco por padrão (fail-safe).
- **Validado:** `pnpm dev` real — `ping` roda sem confirmação,
  `pretend_delete` pede e respeita "s"/"n", as duas decisões batem
  com o audit log.

## Fase 1 — integrações reais

- Apple Calendar (`list_events`/`create_event`) e Apple Reminders
  (`list_reminders`/`create_reminder`), os dois via EventKit
  acessado por JXA (`osascript -l JavaScript`) — sem compilar nada,
  Xcode Command Line Tools quebrado nesta máquina inviabilizou a
  ponte Swift originalmente planejada.
- Notion Calendar como calendário principal/padrão, com
  desambiguação Notion-vs-Apple-Calendar feita inteiramente pela
  `description` de cada tool (não existe roteador central no Agent
  SDK pra isso).
- Gmail leitura (`list_recent_emails`, OAuth próprio via loopback +
  PKCE, refresh token no Keychain do macOS).
- **Decisão mais importante:** bloquear o conector nativo
  `claude_ai_Gmail` do ambiente via `disallowedTools` — ele não passa
  pelo Gateway nem pelo audit log deste projeto, quebrando a garantia
  central de "toda ação passa pela política de risco". A SARAH usa
  exclusivamente sua própria tool.
- **Validado:** todas as quatro integrações testadas contra os
  apps/API reais (evento criado aparece no Calendário, lembrete
  criado aparece no EventKit, página criada no banco Notion real,
  e-mails resumidos batem com a caixa de entrada real) — não só
  revisão de código.

## Fase 2 — memória

- `@sarah/memory`: fatos e preferências persistentes em SQLite+FTS5
  (`remember`/`recall`/`forget`), sobrevivendo a reiniciar o
  processo — diferente de memória de SESSÃO (conversa continuando
  entre turnos dentro da mesma execução do `pnpm dev`), corrigida na
  mesma fase via `resume` do Agent SDK.
- Preferências (`category: "preferencia"`) influenciam outras tools
  automaticamente, sem depender do agente lembrar de chamar
  `recall` — injetadas via `systemPrompt` antes de cada `query()`.
- **Decisão mais importante:** injeção determinística em vez de
  confiar no agente decidir buscar memória sozinho — uma preferência
  guardada precisa valer sempre, não só quando o modelo "lembra" de
  perguntar.
- **Validado:** em DUAS execuções separadas do `pnpm dev` (não a
  mesma sessão) — preferência de lista padrão guardada na execução 1
  foi aplicada sozinha, sem repetir, num lembrete criado na execução
  2, conferido direto no EventKit.

## Fase 3 — Apple Notes e ações de e-mail

- Apple Notes (`list_notes`/`create_note`) via scripting
  `Application("Notes")` — mecanismo diferente de EventKit (Notes.app
  não tem framework público equivalente), com bugs novos e próprios
  (título e primeira linha do body são o mesmo campo, body é HTML de
  verdade).
- Ciclo completo de e-mail: `get_message` (corpo completo sob
  demanda), `create_draft`/`reply_draft` (rascunhos, baixo risco) e
  `send_draft` (**envia um rascunho já existente**, alto risco).
- **Decisão mais importante:** `send_draft` foi uma decisão
  deliberada de habilitar envio de verdade — não existe (nem vai
  existir) uma tool que componha e envie no mesmo passo, o fluxo
  sempre passa por rascunho primeiro; a confirmação busca e mostra o
  conteúdo do rascunho de forma legível (Para/Assunto/corpo) em vez
  do JSON cru.
- **Validado:** rascunho de resposta criado a partir de um e-mail
  real (thread/assunto corretos, conferido pela API do Gmail) e um
  envio real de teste (pra mim mesmo) confirmado com `labelIds:
  ["SENT", "INBOX"]` direto na API — chegou na caixa de entrada de
  verdade.

## Fase 4 — interface gráfica (Electron) + voz

- `apps/menubar`: segunda interface da SARAH — ícone na barra de menu
  do macOS (Tray) que abre uma janela com uma visualização holográfica
  central (Three.js, esfera geodésica azul) DOMINANDO a tela, um
  dashboard de 4 painéis-cartão preenchendo a janela inteira dos dois
  lados dela, e uma barra de controles (microfone, texto minimizável,
  toggle de idioma) — rodando LADO A LADO com o terminal (`apps/cli`),
  sem substituí-lo — as duas interfaces continuam funcionando ao mesmo
  tempo, compartilhando o mesmo `data/sarah.db`.
- **Gateway desacoplado do terminal:** `@sarah/permissions` não tem
  mais `readline` preso dentro — recebe um `confirm` INJETADO (dialog
  nativo do macOS no Electron, `(s/n)` no terminal). `@sarah/core`
  saiu de um loop de terminal (`runSarah`) e virou
  `createSarahSession()`, reusável por qualquer interface — foi essa
  refatoração que permitiu a segunda interface sem duplicar
  Gateway/audit log/memória/tools MCP, só trocando "como chega o
  próximo pedido" e "como se pede confirmação".
- **Dashboard com dado REAL** (nunca decorativo), lido do mesmo audit
  log/config que o resto do projeto já usa: status de cada integração
  (config/permissão presente ou não), proporção de risco baixo/alto,
  atividade por categoria, atividade por hora nas últimas 24h — quatro
  painéis em formato de cartão, dos dois lados da esfera.
- **Esfera central com animação contextual por tarefa:** anima mais
  enquanto aguarda resposta (substitui qualquer indicador de texto
  tipo "digitando..."), e o NÚCLEO no meio dela se TRANSFORMA
  brevemente (~3s) sempre que uma tarefa relevante roda, indicando
  qual foi: envelope voando pro envio de e-mail (Gmail `send_draft`),
  caneta escrevendo pra Apple Notes/Reminders, calendário sendo
  carimbado pro Calendar/Notion (`create_event`), e um pulso/brilho no
  núcleo (sem símbolo) pra memória (`memory.remember`) — nunca duas
  animações sobrepostas, numa fila própria dentro do holograma.
- **Decisão mais importante:** `@sarah/core` roda num processo FILHO
  separado (Node normal do sistema, via `tsx`), não dentro do
  processo do Electron — `better-sqlite3` (usado pelo audit log e
  pela memória) é um módulo nativo com ABI travada a uma versão exata
  do Node, e o Node embutido no Electron usa outra ABI, sem prebuilt
  disponível. O processo do Electron fala com o daemon por JSON Lines
  via stdio; resolve esse caso e qualquer módulo nativo futuro com a
  mesma restrição.
- **Voz — implementada em duas etapas, ambas completas e integradas**:
  primeira etapa validou a capacidade isolada (STT via `whisper.cpp`
  Homebrew, modelo multilíngue `ggml-small.bin`, detecção automática
  português/inglês; TTS via `say` nativo, vozes Luciana pt_BR +
  Samantha en_US — tudo testado com ÁUDIO REAL, gravação ao vivo
  transcrita nos dois idiomas, TTS confirmado ao vivo e por
  round-trip objetivo). Segunda etapa integrou tudo na interface:
  botão de microfone sempre visível (grava até detectar silêncio ou
  até clicar de novo), toda resposta falada em voz alta — mesmo
  quando o pedido veio digitado —, toggle PT/EN escolhendo a VOZ DE
  SAÍDA independente do idioma detectado na entrada, e um estado
  "ouvindo" próprio na esfera (cor verde-azulada, distinta de
  "pensando"). `@sarah/voice` roda inteiro no processo do Electron,
  nunca no daemon — é plumbing de UI local, não uma tool que o agente
  decide chamar, então não passa pelo Gateway. Ver `docs/architecture.md`
  pros achados reais de cada etapa (captura de mic confiável via
  `sox`/`rec`, bug antigo e conhecido do Electron em
  `navigator.geolocation` — timeout constante sem uma `GOOGLE_API_KEY`
  paga, mesmo com a permissão do macOS concedida —, bug do link
  clicável com crase de markdown, entre outros).
- **Dashboard preenche a janela inteira, sem espaço vazio, seguindo um
  mockup de referência**: a esfera + os 4 painéis-cartão (do tamanho
  do próprio conteúdo, centralizados na coluna — não esticados) ocupam
  a janela inteira, sem faixa vazia antes dos controles. A área de
  legenda abaixo da esfera mostra a última resposta e, quando ela
  contém uma URL ou caminho de arquivo real (ex.: um SVG que a SARAH
  acabou de criar), um botão clicável que abre o link/arquivo direto,
  sem precisar abrir o painel de Histórico. O painel de risco virou um
  donut de verdade (dois arcos reais via SVG, porcentagem no centro),
  as listas perderam os emojis (só texto + indicador), e o indicador
  de "configurado" usa a mesma cor de acento da esfera. Um widget de
  canto (pill isolada) mostra data/hora sempre, e clima/localização
  via IP (`ipwho.is`, sem chave, sem popup — troca feita depois do bug
  do `navigator.geolocation` acima) + Open-Meteo, chamadas sempre do
  processo principal, nunca do renderer. Ícones de microfone/teclado
  viraram SVG monocromático, no mesmo traço/paleta do resto da
  interface — o de microfone com destaque de cor por padrão (é o
  método de entrada primário).
- **Validado:** terminal revalidado como idêntico depois da
  refatoração do Gateway; protocolo do daemon (tools, confirmação de
  alto risco, histórico, dashboard) testado isolado, sem Electron no
  meio — inclusive conferindo que os números do dashboard batiam
  exatamente com o audit log real, e que o `toolName` de cada
  categoria (Gmail/Calendar/Reminders/Notes/Memória) chega certo até o
  renderer antes de qualquer clique manual; performance da
  visualização medida de verdade a cada mudança estrutural (~53-59fps
  em todas as rodadas), encaminhando o console do renderer pro
  terminal — sem permissão de Gravação de Tela nesta máquina, essa foi
  a única forma de confirmar sem depender só de olhar a tela; leituras
  de FPS anomalamente baixas apareceram mais de uma vez e SEMPRE foram
  rastreadas até processos Electron órfãos de testes anteriores
  competindo por GPU, nunca uma regressão real do código; uso real
  extenso pelo usuário (Notion, Reminders, Notes, Gmail, incluindo um
  `send_draft` confirmado pelo dialog nativo) registrado no mesmo
  `data/sarah.db` compartilhado com o terminal.

## Fase 5 — sandbox de código, projetos gráficos e Figma (partes 1-6 completas, parte 7 com pendência)

- **Sandbox de código por projeto** (`code.create_project`/
  `write_file`/`run_command`/`git_commit`/`git_push`/`preview`):
  container Podman isolado por projeto — isolamento de rede (só
  internet, nunca a rede local do host) e de filesystem (nada fora da
  pasta do projeto) **confirmado com teste real**, não só configurado.
  `code.create_project` cria a pasta em `~/SarahProjects/<slug>/` **e**
  um repositório PRIVADO no GitHub automaticamente, com uma credencial
  dedicada (chave de deploy por projeto) que nunca entra no container.
  `code.git_push` fica SEMPRE atrás de confirmação de alto risco, sem
  exceção — validado com um push real, confirmado direto na API do
  GitHub, não só pelo texto do agente.
- **Base44** (app builder externo, conta premium) fica disponível só
  se pedido explicitamente pelo nome — nunca escolhido sozinho pelo
  agente; sem pedido explícito, o caminho local (`code.*`) é sempre o
  padrão.
- **Gráficos vetoriais** (`graphics.create_svg`/`export_raster`):
  completo. O modelo escreve o SVG como texto, a tool valida/rasteriza
  (`rsvg-convert`+`imagemagick`) dentro do mesmo sandbox. **Nota
  importante**: SVG é um formato vetorial — não produz imagens
  realistas/fotográficas, isso é limitação do formato, não bug
  (confirmado abrindo os arquivos de verdade).
- **Slides** (`slides.create_presentation`): completo. Gera um `.pptx`
  "esqueleto" real (via `pptxgenjs`) dentro do projeto — texto/layout
  reais, não um mockup. O fluxo esperado é o usuário refinar esse
  arquivo depois no **Claude Design** (produto separado da Anthropic,
  sem integração automática — é handoff manual, não uma feature desta
  tool).
- **Figma** (`figma.export_assets`): implementado e tecnicamente
  funcional — API REST (não Dev Mode MCP: essa rota foi tentada e
  abandonada por bloqueio de allowlist de cliente, ver
  `docs/architecture.md`) —, mas **BLOQUEADO NA PRÁTICA pelo rate
  limit do plano gratuito (Starter) do Figma** (~6 requisições/mês no
  total, compartilhadas entre leitura de arquivo e exportação de
  imagem). Código já otimizado pra minimizar chamadas (reaproveita IDs
  já obtidos, agrupa exportação por formato numa única chamada, loga
  os headers de rate limit). **Decisão encerrada, não mais pendência**:
  o usuário avaliou e decidiu NÃO fazer upgrade pro plano Professional
  — Figma segue implementado e pausado no Starter por escolha; os dois
  projetos reais que ficaram parados continuam parados, sem prazo pra
  retomar.
- **Imagem realista** (raster, via API paga tipo Flux/GPT Image/
  Firefly): avaliada, decisão CONSCIENTE do usuário foi não seguir por
  enquanto — registrada como decisão, não como esquecimento.
- **Vídeo**: descartado do escopo desta fase por decisão do usuário —
  não é retomado sem pedido explícito.
- **Validado:** projeto real de ponta a ponta (site estático, escrita
  de arquivo, comando, commit real, preview respondendo via `curl`
  externo, incluindo reiniciar a sessão); repositório GitHub real
  criado e um push real confirmado na API; SVG exportado pra PNG/JPG e
  aberto de verdade; `.pptx` aberto de verdade no Keynote; e um
  arquivo real do Figma extraído, com `content.json` (estrutura/texto
  reais) validado contra o design de verdade — tudo **confirmado
  visualmente pelo usuário**, sem screenshot automatizado (ver
  `docs/architecture.md` pro quase-incidente que motivou essa
  política).

## Fase 6 — GitHub completo (Pull Requests)

- `code.create_pull_request(project, title, description, base_branch)`:
  criar repositório, commit e push já existiam desde a Fase 5 — só
  faltava o PR. **Fluxo muda pra MUDANÇA num projeto já existente**
  (diferente de criar um projeto novo, que continua indo direto pra
  main/master, sem branch): `code.git_create_branch` (baixo risco, só
  local) → escreve/commita já na branch → `create_pull_request`
  (**ALTO risco, mesmo nível de `git_push`** — na prática é um
  `git_push` de uma branch, feito por dentro da própria tool, antes de
  abrir o PR de verdade).
- **Merge fica de fora, de propósito**: não existe (e não deve existir
  sem pedido explícito) nenhuma tool de merge — a SARAH abre o PR, o
  usuário revisa e mescla ele mesmo pelo GitHub.
- **Achado real evitado antes de implementar**: repositórios criados
  por este projeto recebem `default_branch: "main"` do próprio GitHub
  desde a criação (mesmo vazios), mas o `git` local usa `master` — os
  dois nomes coexistem até o primeiro push de verdade. `base_branch`,
  quando omitido, consulta a branch padrão REAL via API em vez de
  assumir `main` ou `master` de cabeça.
- **Validado:** de ponta a ponta com o Gateway/audit log/GitHub reais
  — dois Pull Requests abertos de verdade contra um projeto já
  existente do usuário, cada um passando por branch → commit → push
  (confirmado) → PR aparecendo no GitHub, sem merge automático.

## Fase 7 — memória semântica, observabilidade e nuance no risco médio (completa)

### Parte 1 — memória semântica

- **`memory.recall` combina palavra-chave (FTS5) com similaridade
  SEMÂNTICA** (embeddings da Voyage AI, modelo `voyage-4-lite`,
  armazenados via `sqlite-vec` no mesmo `sarah-memory.db`) — encontra
  uma memória mesmo quando a pergunta usa palavras totalmente
  diferentes das que foram guardadas (ex.: perguntar "em que período
  do dia costumo marcar encontros?" acha "prefere reuniões de manhã",
  sem nenhuma palavra em comum). Os dois resultados (palavra-chave +
  semântico) são fundidos por Reciprocal Rank Fusion, sem precisar
  calibrar um peso entre escalas incomparáveis (rank do FTS5 vs.
  distância vetorial).
- **`memory.remember` detecta preferência/fato semanticamente parecido
  ANTES de gravar** — se achar algo parecido (não precisa ser texto
  idêntico) da MESMA categoria já guardado, não grava direto: devolve
  a memória conflitante e pede pro agente perguntar ao usuário se é
  pra SUBSTITUIR ou MANTER AS DUAS, em vez de empilhar silenciosamente
  uma contradição. `memory.remember` continua baixo risco sempre; só o
  `memory.forget` de uma eventual substituição passa pela confirmação
  de alto risco de sempre.
- **Resolve as duas notas pendentes da Fase 2**, sem abrir mão das
  garantias que motivaram deixá-las pendentes: a lista de preferências
  injetada no `systemPrompt` continua SEM filtro nenhum (nenhuma
  preferência deixa de valer por "parecer irrelevante" ao pedido
  atual) — só ganhou um teto consultivo (aviso quando passar de 40,
  nunca um bloqueio).
- **Se `VOYAGE_API_KEY` não estiver configurada** (ver `.env.example`),
  a memória continua funcionando NORMALMENTE — só palavra-chave via
  FTS5, exatamente como antes desta fase, sem erro nenhum visível.
- **Bug real corrigido pós-entrega**: `memory.forget` podia falhar
  silenciosamente (`no such module: vec0`) porque a limpeza do índice
  vetorial dependia de um TRIGGER SQL gravado no esquema do arquivo
  `.db` pra sempre, enquanto a extensão `sqlite-vec` carregada é uma
  garantia só POR CONEXÃO — uma conexão do daemon sem a extensão ainda
  tentava rodar o trigger legado e derrubava o apagamento inteiro (nem
  `memories` nem `memories_fts` chegavam a ser apagados). Corrigido
  movendo a limpeza pra código best-effort, sem depender de trigger
  nenhum.
- **Validado:** calibração do limiar de similaridade com embeddings
  REAIS (não intuição); fluxo completo via o agente real
  (`memory.remember` → conflito → `AskUserQuestion` → Gateway pede
  confirmação); busca semântica encontrando memórias reais do usuário
  com uma pergunta em palavras diferentes das guardadas; substituição
  real de uma preferência conflitante, com o bug do trigger reproduzido
  e corrigido rodando o caminho de produção de verdade (não só a
  sessão isolada) — ver `docs/architecture.md` pros achados completos.

### Parte 2 — observabilidade

- **Resultado REAL da execução, não só a decisão do Gateway**:
  `tool_calls` (`@sarah/audit`) ganhou `status`/`error_message`,
  preenchidos pelos hooks `PostToolUse`/`PostToolUseFailure` do Agent
  SDK depois que a tool roda de verdade. Cobre os dois formatos reais
  de falha: o erro "educado" (`{ok:false, error}` como resposta normal
  — a convenção que toda tool deste projeto já usa) e a exceção não
  capturada de verdade (rara). Painel "Erros recentes" novo no
  dashboard.
- **Alertas proativos de falha repetida**: 3 falhas CONSECUTIVAS da
  mesma tool (nunca acumuladas ao longo do tempo) disparam um aviso
  visual no dashboard E a SARAH mencionando isso no início da próxima
  resposta de conversa — uma vez por sequência nova, sem repetir a
  cada turno.
- **Validado:** um erro real forçado (Gmail com id inexistente, Figma
  batendo no rate limit real) aparece com `status=error` e a mensagem
  real da API; uma chamada bem-sucedida continua `status=success`;
  3 falhas seguidas do Figma dispararam o alerta certo, sem repetir
  nos turnos seguintes, e sem disparar à toa pra uma tool saudável.

### Parte 3 — nuance no risco médio (primeira tool: `code.run_command`)

- **`code.run_command` vira risco MÉDIO** — classificação
  determinística por CONTEÚDO do comando, avaliada do zero em CADA
  chamada, nunca por histórico/confiança acumulada (um `rm` real não
  pode se esconder atrás de um histórico bom de chamadas anteriores).
  Uma allowlist de comandos de leitura/build/teste (`ls`, `cat`,
  `pwd`, `npm test`, `npm run build`, `npm run dev`, `git status`,
  `git log`, `git diff`) roda direto; qualquer coisa fora dela
  confirma, com apresentação proporcionalmente mais leve que alto
  risco (sem o aviso de "ALTO RISCO").
- **Achado de segurança real**: a allowlist sozinha tinha uma brecha
  por PREFIXO (`ls; rm -rf .` começa com `ls`) — corrigido bloqueando
  qualquer comando com metacaracteres de encadeamento/redirecionamento
  de shell (`;`, `&&`, `||`, `|`, backtick, `$(...)`, `>`, `<`).
- **`git push`, envio de e-mail e `forget` de memória continuam SEMPRE
  alto risco**, sem allowlist nenhuma — essa é a fronteira real entre
  médio e alto risco, não o nome do nível.
- **Validado:** `git status` (allowlisted) rodou direto, sem pedir
  nada; um `rm` de teste (fora da allowlist) pediu confirmação com
  apresentação diferente da de alto risco — conferido no audit log com
  `risk=medium` e a decisão certa nos dois casos.

**Achado de processo, registrado como regra permanente pra qualquer
sessão do Claude Code neste repo (`CLAUDE.md`)**: tentar verificar
visualmente um resultado desta fase via screenshot de tela inteira
expôs credenciais reais do usuário — pela SEGUNDA vez neste projeto.
A partir de agora essa verificação nunca é feita sozinha, sempre pedida
ao usuário olhar (ver `docs/architecture.md` pro incidente completo).

**Pendências registradas, não escondidas**: rastreamento de expiração
de credencial (token do Gmail expira a cada ~7 dias, PAT do GitHub sem
expiração rastreada — hoje só se descobre quando uma chamada falha de
verdade); extensão da nuance de risco médio pras outras tools do
sandbox (`write_file`, `git_commit`, etc. continuam baixo risco, de
propósito — "primeira tool, não todas de uma vez"). O upgrade do plano
do Figma (Fase 5) **não é mais pendência** — o usuário decidiu não
fazer upgrade; ver seção da Fase 8 abaixo.

**O que este código NÃO faz ainda (de propósito):** merge de Pull
Request (sempre manual, pelo GitHub — decisão deliberada da Fase 6,
não uma lacuna), deploy público de sites (só preview local dentro do
sandbox), imagem realista/vídeo (Fase 5, decisões conscientes de não
seguir por enquanto), rastreamento de expiração de credencial e nuance
de risco médio pras tools além de `run_command` (Fase 7, pendências
registradas acima) — ver o roadmap completo em `docs/architecture.md`.

## Fase 8 — FaceTime (completa); WhatsApp e confirmação por voz (avaliados, abandonados por decisão do usuário)

### FaceTime — completa

- **`apple-contacts.find`** (baixo risco): busca por nome no
  Contacts.app via JXA (mesmo padrão de Calendar/Reminders/Notes),
  devolve telefone(s)/e-mail(s). Descoberta real: `Contacts.app` tem
  DOIS gates de permissão separados (`CNContactStore`, nunca
  solicitado nesta máquina, vs. scripting via Automation/Apple
  Events, já autorizado por fases anteriores) — o status usa o
  caminho da Automation, o mesmo que já funciona.
- **`facetime.call`** (risco MÉDIO, sem allowlist — toda chamada
  confirma, sempre): dispara chamada de VÍDEO via `facetime://`
  (nunca `facetime-audio://`). Confirmado por pesquisa dedicada que o
  macOS SEMPRE exige um clique manual final no app FaceTime pra
  discar de verdade — não é uma escolha deste projeto, é imposto pelo
  sistema operacional, sem brecha técnica pra pular.
- **Validado:** busca real por "Pedro" achou dois contatos e o agente
  pediu desambiguação sozinho; chamada de vídeo real disparada e
  confirmada pelo usuário (não por screenshot — ver regra permanente
  no `CLAUDE.md`).

### WhatsApp — avaliado, prototipado, tecnicamente funcional, ABANDONADO por decisão do usuário

**Não foi uma falha técnica** — vale destacar isso porque é fácil ler
"WhatsApp não está no projeto" e assumir o contrário. A integração
com a WhatsApp Business Platform Cloud API oficial da Meta (nunca
biblioteca não-oficial, por risco de banimento do número) foi
implementada e testada contra a API real: registro do número,
tradução de erros reais (`131047` janela de 24h fechada, `190` token
expirado, `133010` número não registrado, `131030` destinatário fora
da lista permitida), envios de texto livre e de um template
pré-aprovado — todos aceitos pela API com respostas de sucesso reais.

O que motivou abandonar: a fricção de configuração até ali (número de
"negócio" **sempre separado** do WhatsApp pessoal, exigência de
destinatário pré-cadastrado manualmente enquanto o número estiver em
modo de teste, passo extra de registro, e a entrega final nunca
confirmada nos aparelhos reais usados no teste — sem webhook
configurado neste projeto, não há visibilidade de por quê) não valeu
a pena pro uso pretendido, na avaliação do próprio usuário depois de
ver o processo completo. Todo o código (`packages/whatsapp`) foi
removido do repositório — nunca chegou a ser commitado. Detalhe
completo, incluindo os erros reais encontrados passo a passo, em
`docs/architecture.md`.

### Confirmação por voz (card in-app substituindo o diálogo nativo) — avaliada, ABANDONADA por decisão do usuário

Motivado por um bug real encontrado testando o FaceTime (o diálogo
nativo de confirmação, `dialog.showMessageBox`, bloqueia a janela
INTEIRA enquanto aberto, inclusive o botão de microfone — então
responder "sim"/"não" por voz nunca era possível na prática, mesmo
com a lógica de reconhecimento pronta), foi implementado um card de
confirmação DENTRO da própria janela (substituindo o diálogo nativo
por completo) que deixava mic/texto clicáveis com a confirmação na
tela, mais o reconhecimento de "sim"/"não" por voz/texto respondendo
a Promise da confirmação diretamente. Chegou a ser testado
parcialmente (ver `docs/architecture.md` pro relato completo,
incluindo um incidente real de teste automatizado interceptando por
acidente uma confirmação de verdade do usuário — sem consequência real
porque a chamada afetada nunca chegou a rodar).

O usuário decidiu encerrar esse trabalho ANTES da validação final de
ponta a ponta — não por ter dado errado, por escolha: o diálogo nativo
de confirmação continua exatamente como sempre foi, exigindo clique
manual, sem confirmação por voz. Todo o código (nunca tinha sido
commitado) foi revertido.

## Setup

```bash
pnpm install
cp .env.example .env
pnpm dev              # terminal (apps/cli)
pnpm --filter menubar dev   # janela/Tray (apps/menubar) — pode rodar junto com o terminal
```

`.env` precisa, no mínimo, do `NOTION_API_KEY`/
`NOTION_CALENDAR_DATABASE_ID` (Notion Calendar) e `GOOGLE_CLIENT_ID`/
`GOOGLE_CLIENT_SECRET` (Gmail) — ver comentários em `.env.example`
pra como conseguir cada um. Se você já usa Claude Code localmente e
está autenticado, o Agent SDK reaproveita essa sessão pro
`ANTHROPIC_API_KEY`.

Antes do primeiro uso do Gmail, rode `pnpm gmail:auth` uma vez (abre o
navegador, pede login/consentimento Google) — o refresh token fica no
Keychain do macOS, nunca em arquivo. Reautorizar é necessário se o
escopo pedido mudar (já aconteceu uma vez nesta fase) ou se o token
expirar — o app OAuth roda em modo "Testing" de propósito (decisão
registrada em `docs/architecture.md`), então o token expira a cada
~7 dias.

Pra Fase 5: `pnpm github:auth` uma vez (PAT clássico, escopo `repo`,
Keychain) antes do primeiro `code.create_project` — sem isso, o
projeto é criado só localmente, sem repositório no GitHub. `pnpm
figma:auth` uma vez (token de acesso pessoal, escopos `file_content:
read`+`current_user:read`, Keychain) antes do primeiro
`figma.export_assets` — **atenção à cota**: contas sem assento Dev/
Full pago no Figma têm um limite de só ~6 chamadas por MÊS pra leitura
de arquivo + exportação de imagem juntas (ver `docs/architecture.md`,
Fase 5 parte 7).

Pra Fase 7 (memória semântica): `VOYAGE_API_KEY` no `.env` (crie uma
conta em https://dashboard.voyageai.com) — **atenção à cota**: sem
cartão de pagamento cadastrado no painel da Voyage, o limite é de só 3
requisições por MINUTO, o que pode fazer a busca semântica falhar
ocasionalmente sob uso pesado (degrada pra busca por palavra-chave
automaticamente, nunca quebra o app — ver `docs/architecture.md`, Fase
7 parte 1). Sem essa chave configurada, a memória funciona
normalmente, só sem busca semântica/checagem de conflito.

## O que testar

No prompt que abrir no terminal, exemplos por fase:

**Fase 0**: `me dê um ping com a mensagem oi` (roda direto, baixo
risco) / `finja apagar o arquivo teste.txt` (pede confirmação `(s/n)`,
alto risco).

**Fase 1**: `liste meus eventos de hoje` / `marca um compromisso
amanhã às 15h` (Notion, padrão) / `cria um evento no Apple Calendar
amanhã às 15h` (só se pedido explicitamente) / `cria um lembrete pra
ligar pro dentista` / `resuma meus e-mails de hoje`.

**Fase 2**: `lembra que eu sempre quero lembretes na lista Trabalho
por padrão` — reinicie o `pnpm dev` depois e peça `cria um lembrete
pra revisar o relatório` sem especificar lista: deve usar "Trabalho"
sozinho. `o que você sabe sobre mim?` recupera o que foi guardado.

**Fase 3**: `lista minhas notas` / `cria uma nota com...` / `abre o
e-mail de fulano e cria um rascunho de resposta` (chama `get_message`
+ `reply_draft`, baixo risco, sem confirmação) / `envia o rascunho
<id>` (chama `send_draft`, **alto risco** — deve mostrar Para/Assunto/
corpo de forma legível e pedir confirmação antes de enviar de
verdade).

**Fase 4**: rode `pnpm --filter menubar dev` — procure um ícone
circular pequeno na barra de menu do macOS (tooltip "SARAH"). Clique
pra abrir o dashboard: a esfera holográfica GRANDE e centralizada, com
dois painéis-cartão de cada lado (status das integrações e proporção
de risco à esquerda; atividade por categoria e atividade por hora à
direita) preenchendo a janela até perto do rodapé — sem lista de
mensagens empilhada (a conversa completa mora no painel de Histórico,
abaixo). `me dê um ping com a mensagem oi` roda direto, digitado (ícone
de teclado expande um campo minimizado) — o holograma anima mais forte
enquanto espera ("pensando", mostrado na legenda abaixo da esfera), os
painéis de risco/categoria/atividade se atualizam sozinhos depois da
resposta, e a resposta é FALADA em voz alta (voz do idioma marcado no
toggle PT/EN, independente do idioma do pedido). Clique no ícone de
microfone e fale o mesmo pedido — a esfera muda pra um verde-azulado
("ouvindo") enquanto grava, para sozinha com silêncio ou no clique de
novo, transcreve e trata exatamente como texto. `finja apagar o
arquivo teste.txt` abre um dialog nativo do macOS (não dentro da
janela) pedindo confirmação. Cada resposta mostra um selo discreto de
qual tool rodou (só texto); peça algo que crie um evento/lembrete/
nota, ou que envie um e-mail (`send_draft`), e observe o NÚCLEO
CENTRAL da esfera se transformar por ~3s — cresce/brilha e mostra um
símbolo (envelope voando, caneta escrevendo, calendário carimbado) de
acordo com a tarefa, depois volta ao normal; peça pra "lembrar" de
algo (memória persistente) e o núcleo só brilha/cresce, sem símbolo.
Se duas tarefas rodarem na mesma resposta, a segunda animação só
começa depois que a primeira termina. Peça pra criar um SVG (Fase 5)
e veja a legenda mostrar um chip clicável com o caminho do arquivo —
clique abre direto, sem passar pelo Histórico. O canto da tela mostra
uma pill isolada com data/hora sempre, e clima/localização por IP
(sem popup nenhum). Botão direito no ícone → "Histórico..." abre uma
janela com a conversa completa e as últimas ações do Gateway.

**Fase 5**: `cria um site estático simples chamado teste` (chama
`code.create_project` + `code.write_file`, baixo risco — cria a pasta
em `~/SarahProjects/teste/` e um repositório privado no GitHub, se
`pnpm github:auth` já tiver sido rodado) / `mostra um preview` (`code.
preview`, abre uma URL local) / `dá push pro GitHub` (`code.git_push`,
**alto risco** — sempre pede confirmação, sem exceção) / `cria uma
logo em SVG pro projeto teste` (`graphics.create_svg` +
`export_raster`, baixo risco) / `gera uma apresentação sobre X`
(`slides.create_presentation`, baixo risco, gera um `.pptx` real).
Figma (`figma.export_assets`, baixo risco) precisa de `pnpm figma:auth`
rodado antes e um `fileKey` real — **cuidado com a cota**: contas sem
assento pago no Figma têm só ~6 chamadas/mês, então não vale ficar
testando repetido (ver nota em "Setup" acima e `docs/architecture.md`).

**Fase 6**: num projeto JÁ EXISTENTE (não um recém-criado), peça
`muda X e abre um Pull Request pra isso` — confirme que a SARAH cria
uma branch antes de mexer em qualquer arquivo (`code.git_create_branch`,
sem confirmação), commita nela, e só então `create_pull_request` pede
confirmação (**alto risco**, mostra projeto/título/base/descrição)
antes de enviar a branch e abrir o PR de verdade no GitHub — sem
mesclar sozinha.

**Fase 7, parte 1 (memória semântica)**: `lembra que eu sempre quero
que lembretes sejam criados na lista Trabalho por padrão`, depois (numa
mensagem separada) `na verdade, prefiro que lembretes vão pra lista
Pessoal por padrão` — confirme que a SARAH detecta a semelhança com a
preferência anterior (via `memory.remember` ou `memory.recall`) e
pergunta antes de decidir substituir ou manter as duas, em vez de
guardar as duas silenciosamente. `o que você sabe sobre mim?` continua
funcionando como antes; pergunte algo com PALAVRAS DIFERENTES do que
foi guardado (ex.: se guardou algo sobre "reuniões de manhã", pergunte
"que período do dia costumo marcar encontros?") pra confirmar que a
busca semântica encontra mesmo assim.

**Fase 7, parte 2 (observabilidade)**: force um erro real — peça pra
`get_message` (Gmail) ler um `messageId` inventado, ou tente
`figma.export_assets` sabendo que a cota está estourada — e confira o
painel "Erros recentes" do dashboard (`apps/menubar`) mostrando a
falha com a mensagem real da API. Repita a mesma chamada com erro
umas 3 vezes seguidas: deve aparecer um alerta destacado no dashboard
E a próxima resposta da SARAH deve mencionar isso proativamente antes
de tratar seu pedido — só uma vez, não a cada turno seguinte.

**Fase 7, parte 3 (nuance no risco médio)**: num projeto já existente,
peça `roda git status nesse projeto` (`code.run_command`, allowlist —
deve rodar DIRETO, sem pedir nada) e depois `apaga o arquivo X desse
projeto` usando `rm` (fora da allowlist) — deve pedir confirmação,
mas com uma apresentação mais leve que o aviso de alto risco de
sempre (sem o texto "ALTO RISCO"). Peça um comando ENCADEADO (ex.:
`ls && cat outro-arquivo`) e confirme que também pede confirmação,
mesmo os dois comandos sendo individualmente inofensivos — encadear
tira da allowlist.

A primeira chamada de cada integração do sistema (Calendar, Reminders,
Notes) deve mostrar um diálogo do macOS pedindo permissão pro processo
`osascript` — precisa clicar em permitir, não dá pra automatizar essa
parte.

`data/sarah.db` (SQLite) tem a tabela `tool_calls` com o histórico de
todas as decisões do Gateway — é a base pra "SARAH, o que você fez
hoje?".

## Por que o `dev` não usa watch mode

De propósito. `tsx watch` reinicia o processo a cada mudança de
arquivo — e como o audit log grava em `data/sarah.db`, dentro da
própria pasta observada, cada tool call reiniciava a sessão sozinha.
Pra um REPL que mantém estado (SQLite aberto, histórico da conversa
via `resume`), isso nunca é o que você quer. Se um dia quiser
live-reload pra desenvolvimento, rode `tsx watch --ignore data
src/main.ts` manualmente — só não deixe isso como o script padrão.

## Bug corrigido: `allowedTools` pulava o Gateway

Na primeira versão deste código, os nomes das tools de teste estavam
em `allowedTools`. Nesse SDK, isso **pré-aprova a tool antes do
`canUseTool` ser consultado** — o próprio SDK avisa isso com o warning
`CLAUDE_SDK_CAN_USE_TOOL_SHADOWED`. Correção: nenhuma tool deste
projeto entra em `allowedTools` — todas "caem" no `canUseTool`
(o Gateway) normalmente, e isso vale pra toda integração adicionada
desde então.

## Se algo não bater

Todo o código deste repositório foi validado rodando de verdade —
`pnpm dev` de ponta a ponta, contra os apps/APIs reais, não só revisão
estática — em cada fase, com os bugs reais encontrados (e como foram
corrigidos) documentados em `docs/architecture.md`. Se mesmo assim
algo não bater com a versão do SDK/API que você tem instalada, a
mensagem de erro geralmente já vem com contexto suficiente (os bridges
JXA propagam `stderr` nas exceções, os clients HTTP tratam os erros
mais comuns de cada API com mensagens específicas) — mas cola aqui que
a gente ajusta junto.
