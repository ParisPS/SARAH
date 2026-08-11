# SARAH — Fase 0 + Fase 1 (Apple Calendar)

Monorepo com Claude Agent SDK, Gateway de permissões e log de
auditoria em SQLite (Fase 0), agora com a primeira integração real:
**Apple Calendar via EventKit** (Fase 1) — `list_events` e
`create_event`, chamadas por uma ponte JXA (`osascript -l
JavaScript`), sem precisar de compilador nenhum. As tools de teste
(`ping` / `pretend_delete`) continuam registradas como sanity check.

**O que este código NÃO faz ainda (de propósito):** Notion, Apple
Reminders/Notes, e-mail, GitHub, nenhum acesso a Bash/arquivos do seu
computador pelo agente, nenhuma execução de código.

## Setup

```bash
pnpm install
cp .env.example .env   # se você ainda não usa `claude login` localmente
pnpm dev
```

Se você já roda o Claude Code na sua máquina e está autenticado, o
Agent SDK reaproveita essa sessão e o `.env` pode nem ser necessário
— nesse caso pode pular o `cp .env.example .env`.

## O que testar

No prompt que abrir no terminal:

1. `me dê um ping com a mensagem oi` — deve rodar **direto**, sem
   pedir confirmação (é a tool de baixo risco).
2. `finja apagar o arquivo teste.txt` — deve **parar e perguntar**
   "Confirmar execução? (s/n)" antes de rodar (é a tool de alto
   risco). Responda `n` uma vez pra ver a negação funcionando, e `s`
   outra vez pra ver a execução.

Depois de rodar os dois, o arquivo `data/sarah.db` (SQLite) vai ter
uma tabela `tool_calls` com o histórico de decisões — essa é a base
do "SARAH, o que você fez hoje?" das próximas fases.

## O que testar (Fase 1 — Apple Calendar)

3. `liste meus eventos de hoje` — chama `list_events`. Na primeira
   vez, o macOS deve mostrar um diálogo pedindo acesso ao Calendário
   pro processo `osascript` — **precisa clicar em permitir**, não dá
   pra automatizar essa parte. Depois de aprovado, roda direto, sem
   pedir confirmação no terminal (baixo risco).
4. `cria um evento de teste amanhã às 15h chamado "Teste SARAH"` —
   chama `create_event`, também sem pedir confirmação. Confere no
   app Calendário de verdade que o evento apareceu.

Se `list_events`/`create_event` derem erro, o mais provável é
mensagem vindo da ponte JXA
(`packages/apple-calendar/native/eventkit-bridge.js`) — o `bridge.ts`
propaga o `stderr` do `osascript` na exceção, então a mensagem de
erro já vem com contexto.

## Por que o `dev` não usa watch mode

De propósito. `tsx watch` reinicia o processo a cada mudança de
arquivo — e como o audit log grava em `data/sarah.db`, dentro da
própria pasta observada, cada tool call reiniciava a sessão sozinha.
Pra um REPL que mantém estado (SQLite aberto, histórico da conversa),
isso nunca é o que você quer. Se um dia quiser live-reload pra
desenvolvimento, rode `tsx watch --ignore data src/main.ts`
manualmente — só não deixe isso como o script padrão.

## Bug corrigido: `allowedTools` pulava o Gateway

Na primeira versão deste código, os nomes das tools de teste estavam
em `allowedTools`. Nesse SDK, isso **pré-aprova a tool antes do
`canUseTool` ser consultado** — o próprio SDK avisa isso com o
warning `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED`. Na prática, o
`pretend_delete` executava direto, sem pedir confirmação, e o audit
log ficava vazio (porque `onDecision` só roda dentro do Gateway).

Correção: os nomes saíram de `allowedTools`. Agora as duas tools
"caem" no `canUseTool` normalmente, e `disallowedTools` bloqueia as
tools nativas do agente (Bash, Write, Edit etc.) que ainda não devem
existir nessa fase.

**Ao testar de novo**, o esperado é:

- `me dê um ping...` → roda direto, sem perguntar nada (baixo risco).
- `finja apagar...` → agora sim deve **parar** e mostrar
  `⚠️ Ação de ALTO RISCO solicitada` + `Confirmar execução? (s/n)`
  antes de fazer qualquer coisa. Se isso não aparecer, a correção não
  pegou — me avisa.

## Se algo não bater com o SDK

Este código foi escrito consultando a documentação atual do Claude
Agent SDK, mas **não foi executado** (o ambiente onde foi gerado não
tem acesso à internet). Os pontos com maior chance de precisar de
ajuste fino se o `pnpm dev` reclamar:

- O formato exato do `input` passado pra `tool()` — se a versão que
  você instalou usa uma assinatura ligeiramente diferente da atual.
- O nome exato de alguns campos em `PermissionResult` /
  `CanUseTool` — a API do SDK está evoluindo rápido.
- Se `@anthropic-ai/claude-agent-sdk@^0.3.200` não existir mais como
  faixa de versão, ajuste pra versão mais recente disponível.

Qualquer erro do `pnpm install` ou `pnpm dev`, me cola aqui a
mensagem que a gente ajusta junto.

## Próximo passo depois desta fase

Com o pipeline validado (ping passa direto, pretend_delete pede
confirmação, e o SQLite registra as duas decisões), o próximo passo é
a Fase 1: trocar as tools de teste pela primeira tool real —
Apple Calendar via EventKit — mantendo exatamente essa mesma
estrutura de Gateway + audit log.
