# SARAH — Fases 0-6 completas (voz adiada; Figma com pendência de cota)

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

## Fase 4 — interface gráfica (Electron), voz adiada

- `apps/menubar`: segunda interface da SARAH — ícone na barra de menu
  do macOS (Tray) que abre uma janela (820x800) com chat, uma
  visualização holográfica central (Three.js, esfera geodésica azul)
  e um dashboard, rodando LADO A LADO com o terminal (`apps/cli`), sem
  substituí-lo — as duas interfaces continuam funcionando ao mesmo
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
- **Voz (entrada e saída) fazia parte do escopo original desta fase e
  foi DELIBERADAMENTE ADIADA** — não é algo esquecido, é uma decisão
  de sequenciamento tomada no começo da fase (voz tratada como etapa
  própria, independente da interface gráfica; ver roadmap em
  `docs/architecture.md`). Por isso o título desta seção é "interface
  completa, voz adiada": a Fase 4 não está 100% fechada no sentido do
  escopo original, só a parte de interface está pronta. O holograma já
  tem um gancho pronto (`setAudioLevel`) pra reagir a volume de voz
  quando essa etapa começar.
- **Voz, primeira etapa — capacidade de áudio validada isolada, AINDA
  NÃO integrada na interface**: STT (`whisper.cpp` via Homebrew,
  modelo multilíngue `ggml-small.bin`, detecção automática de
  português/inglês) e TTS (`say` nativo do macOS, vozes Luciana pt_BR
  + Samantha en_US) testados com ÁUDIO REAL — gravação ao vivo do
  usuário transcrita corretamente nos dois idiomas, TTS confirmado ao
  vivo e por round-trip objetivo (gera áudio → transcreve → compara
  texto). `apps/menubar`/`apps/cli` não foram tocados nesta etapa —
  ver `docs/architecture.md` pros achados reais (Homebrew desatualizado
  não reconhecia o macOS desta máquina, captura de mic padrão do
  `whisper-cpp` trava, `sox`/`rec` acabou sendo o caminho confiável) e
  pro runbook de gravação validado.
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
  limit do plano gratuito do Figma** (~6 requisições/mês no total,
  compartilhadas entre leitura de arquivo e exportação de imagem).
  Código já otimizado pra minimizar chamadas (reaproveita IDs já
  obtidos, agrupa exportação por formato numa única chamada, loga os
  headers de rate limit). **Pendência explícita, não escondida**: dois
  projetos reais do usuário prontos e parados esperando decisão sobre
  upgrade pro plano Professional do Figma.
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

**O que este código NÃO faz ainda (de propósito):** voz (ver acima —
Fase 4 mesmo, adiada, não esquecida), merge de Pull Request (sempre
manual, pelo GitHub — decisão deliberada da Fase 6, não uma lacuna),
deploy público de sites (só preview local dentro do sandbox), imagem
realista/vídeo (Fase 5, decisões conscientes de não seguir por
enquanto) e memória semântica — ver o roadmap completo em
`docs/architecture.md`.

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
direita) e a conversa embaixo. `me dê um ping com a mensagem oi` roda
direto (o holograma anima mais forte enquanto espera, sem texto
"pensando..."; os painéis de risco/categoria/atividade se atualizam
sozinhos depois da resposta); `finja apagar o arquivo teste.txt` abre
um dialog nativo do macOS (não dentro da janela) pedindo confirmação.
Cada resposta mostra um selo discreto de qual tool rodou (só texto);
peça algo que crie um evento/lembrete/nota, ou que envie um e-mail
(`send_draft`), e observe o NÚCLEO CENTRAL da esfera se transformar
por ~3s — cresce/brilha e mostra um símbolo (envelope voando, caneta
escrevendo, calendário carimbado) de acordo com a tarefa, depois volta
ao normal; peça pra "lembrar" de algo (memória persistente) e o núcleo
só brilha/cresce, sem símbolo. Se duas tarefas rodarem na mesma
resposta, a segunda animação só começa depois que a primeira termina.
Botão
direito no ícone → "Histórico..." abre uma janela com as últimas ações
do Gateway.

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
