# SARAH — assistente pessoal local (Fases 0-9)

Assistente pessoal rodando localmente no Mac, construído com o Claude
Agent SDK: um Gateway de permissões baseado em risco na frente de
toda tool, log de auditoria em SQLite, e integrações reais com apps
do sistema e serviços externos. Cada capacidade abaixo foi validada
rodando de verdade contra o app/API real, não só revisão de código —
o histórico técnico completo (decisões, bugs reais e o porquê de cada
escolha) está em [`docs/architecture.md`](docs/architecture.md); lições
práticas rápidas de consultar estão em [`docs/DICAS.md`](docs/DICAS.md).

## Fase 0 — fundação

Gateway de permissões baseado em risco (`@sarah/permissions`): toda
tool passa por `canUseTool` antes de rodar — risco não vive dentro da
tool, uma política central classifica e decide se confirma; tool
desconhecida é alto risco por padrão (fail-safe). Log de auditoria em
SQLite (`@sarah/audit`), toda decisão do Gateway gravada em
`data/sarah.db`.

## Fase 1 — integrações reais

- Apple Calendar (`list_events`/`create_event`) e Apple Reminders
  (`list_reminders`/`create_reminder`) via EventKit, acessado por JXA
  (`osascript -l JavaScript`).
- Notion Calendar como calendário principal/padrão — desambiguação
  com Apple Calendar feita pela `description` de cada tool.
- Gmail leitura (`list_recent_emails`) — OAuth próprio (loopback +
  PKCE), refresh token no Keychain do macOS. O conector nativo
  `claude_ai_Gmail` do ambiente fica bloqueado de propósito — a SARAH
  usa exclusivamente sua própria tool, que passa pelo Gateway.

## Fase 2 — memória

`@sarah/memory`: fatos e preferências persistentes em SQLite+FTS5
(`remember`/`recall`/`forget`), sobrevivendo a reiniciar o processo —
diferente de memória de SESSÃO (conversa entre turnos dentro da mesma
execução, via `resume` do Agent SDK). Preferências
(`category: "preferencia"`) influenciam outras tools automaticamente,
injetadas no `systemPrompt` antes de cada pedido — nunca depende do
agente lembrar de chamar `recall` sozinho.

## Fase 3 — Apple Notes e ações de e-mail

Apple Notes (`list_notes`/`create_note`) via `Application("Notes")`.
Ciclo completo de e-mail: `get_message` (corpo completo sob demanda),
`create_draft`/`reply_draft` (rascunhos, baixo risco) e `send_draft`
(**envia um rascunho já existente, alto risco** — a confirmação
mostra Para/Assunto/corpo de forma legível). Não existe, e não vai
existir, uma tool que componha e envie no mesmo passo.

## Fase 4 — interface gráfica (Electron) + voz

`apps/menubar`: segunda interface da SARAH — ícone na barra de menu
do macOS que abre uma janela com visualização holográfica central
(Three.js), dashboard com painéis de dado REAL (status de
integrações, proporção de risco, atividade por categoria/hora, erros
recentes), e uma barra de controles (microfone, texto minimizável,
toggle de idioma). Roda lado a lado com o terminal (`apps/cli`),
compartilhando o mesmo `data/sarah.db` — a mesma `@sarah/core`
(`createSarahSession()`) atende as duas interfaces, só troca "como
chega o pedido" e "como se pede confirmação" (dialog nativo vs.
`(s/n)` no terminal).

**Voz**: STT via `whisper.cpp` (modelo multilíngue, detecção
automática português/inglês) e TTS via `say` nativo (vozes Luciana
pt-BR / Samantha en-US). Botão de microfone sempre visível, grava até
detectar silêncio ou até clicar de novo; toda resposta é falada em
voz alta, mesmo quando o pedido veio digitado; toggle PT/EN escolhe a
voz de SAÍDA, independente do idioma detectado na entrada.

## Fase 5 — sandbox de código, gráficos, slides e Figma

- **Sandbox de código** (`code.create_project`/`write_file`/
  `run_command`/`git_commit`/`git_push`/`create_pull_request`/
  `preview`): container Podman isolado por projeto (rede só internet,
  filesystem só a pasta do projeto). `create_project` cria a pasta em
  `~/SarahProjects/<slug>/` e um repositório privado no GitHub
  automaticamente. `git_push`/`create_pull_request` sempre exigem
  confirmação de alto risco, sem exceção — mudança num projeto já
  existente sempre passa por branch antes do commit.
- **Base44** (app builder externo, conta premium) só entra se pedido
  explicitamente pelo nome — nunca escolhido sozinho pelo agente.
- **Gráficos vetoriais** (`graphics.create_svg`/`export_raster`) e
  **slides** (`slides.create_presentation`, gera um `.pptx` real via
  `pptxgenjs`).
- **Figma** (`figma.export_assets`): busca estrutura/texto reais de um
  arquivo e exporta imagens, via API REST — sujeito à cota do plano
  gratuito do Figma (~6 chamadas/mês entre leitura e exportação, ver
  Setup abaixo).

## Fase 6 — GitHub completo (Pull Requests)

`code.create_pull_request(project, title, description, base_branch)`
— sempre alto risco (na prática inclui um `git_push` de verdade).
Merge fica de fora, de propósito: a SARAH abre o PR, o usuário revisa
e mescla ele mesmo pelo GitHub.

## Fase 7 — memória semântica, observabilidade e risco médio

- **Memória semântica**: `memory.recall` combina busca por
  palavra-chave (FTS5) com similaridade semântica (embeddings Voyage
  AI + `sqlite-vec`) — encontra uma memória mesmo com palavras
  diferentes das que foram guardadas. `memory.remember` detecta
  preferência/fato semanticamente parecido ANTES de gravar e pergunta
  se é pra substituir ou manter as duas.
- **Observabilidade**: `tool_calls` ganhou o RESULTADO real de cada
  execução (não só a decisão do Gateway) — painel "Erros recentes" no
  dashboard, e alerta proativo (visual + a SARAH mencionando) quando a
  mesma tool falha 3 vezes seguidas.
- **Risco médio**: `code.run_command` classifica por CONTEÚDO do
  comando a cada chamada — uma allowlist pequena (leitura/build/teste)
  roda direto, o resto confirma com apresentação mais leve que alto
  risco. `git push`, envio de e-mail e `forget` de memória continuam
  SEMPRE alto risco, sem allowlist nenhuma.

## Fase 8 — FaceTime

`apple-contacts.find` (busca por nome no Contacts.app, baixo risco)
resolve nome → telefone/e-mail pra `facetime.call` (dispara chamada
de VÍDEO via `facetime://`, risco médio — toda chamada confirma,
sempre, sem allowlist).

## Fase 9 — busca de preços

`web.search_price(item)` — busca preços reais de um produto/serviço
(via Google Shopping/Serper.dev), devolvendo algumas opções com
título, preço, loja e link. Tool própria e focada, não a `WebSearch`
genérica do Agent SDK (que continua bloqueada). Baixo risco, só
leitura — nunca inventa preço; lista vazia é resposta válida.

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
Keychain do macOS, nunca em arquivo. O app OAuth roda em modo
"Testing" de propósito, então o token expira a cada ~7 dias —
reautorize rodando o mesmo comando de novo.

Pra Fase 5: `pnpm github:auth` uma vez (PAT clássico, escopo `repo`,
Keychain) antes do primeiro `code.create_project` — sem isso, o
projeto é criado só localmente, sem repositório no GitHub. `pnpm
figma:auth` uma vez (token de acesso pessoal, Keychain) antes do
primeiro `figma.export_assets` — **atenção à cota**: contas sem
assento pago no Figma têm um limite de só ~6 chamadas por MÊS pra
leitura de arquivo + exportação de imagem juntas.

Pra Fase 7 (memória semântica): `VOYAGE_API_KEY` no `.env` (crie uma
conta em https://dashboard.voyageai.com) — sem cartão de pagamento
cadastrado, o limite é de só 3 requisições por MINUTO (degrada pra
busca por palavra-chave automaticamente, nunca quebra o app). Sem essa
chave configurada, a memória funciona normalmente, só sem busca
semântica/checagem de conflito.

## O que testar

No prompt que abrir no terminal (ou na janela do menu bar), exemplos
por fase:

**Fase 0**: `me dê um ping com a mensagem oi` (roda direto) / `finja
apagar o arquivo teste.txt` (pede confirmação).

**Fase 1**: `liste meus eventos de hoje` / `marca um compromisso
amanhã às 15h` (Notion, padrão) / `cria um evento no Apple Calendar
amanhã às 15h` (só se pedido explicitamente) / `cria um lembrete pra
ligar pro dentista` / `resuma meus e-mails de hoje`.

**Fase 2**: `lembra que eu sempre quero lembretes na lista Trabalho
por padrão` — reinicie o `pnpm dev` depois e peça `cria um lembrete
pra revisar o relatório` sem especificar lista: deve usar "Trabalho"
sozinho. `o que você sabe sobre mim?` recupera o que foi guardado.

**Fase 3**: `lista minhas notas` / `cria uma nota com...` / `abre o
e-mail de fulano e cria um rascunho de resposta` / `envia o rascunho
<id>` (alto risco — mostra Para/Assunto/corpo e pede confirmação).

**Fase 4**: rode `pnpm --filter menubar dev` — clique no ícone na
barra de menu. `me dê um ping com a mensagem oi` digitado (ícone de
teclado expande o campo) ou falado (ícone de microfone) — a resposta
é falada em voz alta e os painéis do dashboard se atualizam sozinhos.
`finja apagar o arquivo teste.txt` abre um dialog nativo pedindo
confirmação. Botão direito no ícone → "Histórico..." mostra a
conversa completa e as últimas ações do Gateway.

**Fase 5**: `cria um site estático simples chamado teste` / `mostra um
preview` / `dá push pro GitHub` (alto risco) / `cria uma logo em SVG
pro projeto teste` / `gera uma apresentação sobre X`. Figma precisa de
`pnpm figma:auth` rodado antes e um `fileKey` real — cuidado com a
cota (~6 chamadas/mês sem assento pago).

**Fase 6**: num projeto JÁ EXISTENTE, peça `muda X e abre um Pull
Request pra isso` — confirme que cria uma branch antes de mexer em
qualquer arquivo, e que `create_pull_request` pede confirmação (alto
risco) antes de abrir o PR de verdade.

**Fase 7**: `lembra que eu sempre quero que lembretes sejam criados na
lista Trabalho por padrão`, depois `na verdade, prefiro que lembretes
vão pra lista Pessoal por padrão` — confirme que pergunta antes de
substituir. Force um erro real (ex.: `get_message` com um `messageId`
inventado) e confira o painel "Erros recentes" do dashboard. Num
projeto existente, `roda git status nesse projeto` deve rodar DIRETO
(allowlist); `roda ls && cat outro-arquivo` deve pedir confirmação
mesmo sendo comandos inofensivos (encadear tira da allowlist).

**Fase 8**: `busca o contato do Fulano` / `liga por vídeo pro Fulano`
(pede confirmação leve antes de discar).

**Fase 9**: `quanto custa uma Air Fryer 4L` — busca preços reais na
web, sem pedir confirmação (baixo risco).

A primeira chamada de cada integração do sistema (Calendar, Reminders,
Notes, Contacts) mostra um diálogo do macOS pedindo permissão pro
processo `osascript` — precisa clicar em permitir, não dá pra
automatizar essa parte.

`data/sarah.db` (SQLite) tem a tabela `tool_calls` com o histórico de
todas as decisões do Gateway.

## Mais fundo

- [`docs/architecture.md`](docs/architecture.md) — histórico técnico
  completo: toda decisão de arquitetura, bug real encontrado e o
  porquê de cada escolha, fase por fase (inclui também o que foi
  avaliado e conscientemente descartado, com o motivo).
- [`docs/DICAS.md`](docs/DICAS.md) — lições práticas rápidas de
  consultar, formato "se X acontecer, provavelmente é Y".
