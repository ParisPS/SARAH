# SARAH — Fases 0-3 completas

Assistente pessoal rodando localmente no Mac, construído com o Claude
Agent SDK: um Gateway de permissões baseado em risco na frente de
toda tool, log de auditoria em SQLite, e integrações reais com apps
do sistema e serviços externos. Cada fase é validada rodando de
verdade (não só revisão de código) — o histórico completo de decisões
e bugs reais encontrados está em [`docs/architecture.md`](docs/architecture.md).

**O que já funciona:**

- **Fase 0** — fundação: Gateway de permissões (`@sarah/permissions`),
  audit log em SQLite (`@sarah/audit`), tools de teste (`ping`/
  `pretend_delete`) como sanity check.
- **Fase 1** — integrações reais: Apple Calendar (`list_events`/
  `create_event`, via EventKit/JXA), Notion Calendar (calendário
  principal do usuário), Apple Reminders (`list_reminders`/
  `create_reminder`, via EventKit/JXA), Gmail leitura
  (`list_recent_emails`, OAuth próprio).
- **Fase 2** — memória: `@sarah/memory` guarda fatos/preferências
  persistentes em SQLite+FTS5 (`remember`/`recall`/`forget`), com
  preferências influenciando automaticamente o comportamento de
  outras tools (injeção via `systemPrompt`, sem depender do agente
  decidir buscar). Memória de SESSÃO (conversa continuando entre
  turnos dentro da mesma execução) via `resume` do Agent SDK.
- **Fase 3** — Apple Notes (`list_notes`/`create_note`, scripting via
  `Application("Notes")`) e o ciclo completo de e-mail: `get_message`
  (corpo completo sob demanda), `create_draft`/`reply_draft`
  (rascunhos, baixo risco) e `send_draft` (**envia um rascunho já
  existente** — alto risco, decisão deliberada, com confirmação
  mostrando o conteúdo legível antes de perguntar). Nenhuma tool
  "compõe e envia" no mesmo passo — o fluxo sempre passa por rascunho
  primeiro.

**O que este código NÃO faz ainda (de propósito):** app de menu bar
nativo (ainda é terminal), agente de código/sandbox, GitHub, deploy de
sites, memória semântica — ver o roadmap completo em
`docs/architecture.md`.

## Setup

```bash
pnpm install
cp .env.example .env
pnpm dev
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
