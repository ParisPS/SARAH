# Instruções permanentes pra qualquer sessão do Claude Code neste repo

## Commit e push automáticos

A partir de 2026-08-11, commite e dê push a cada mudança
significativa **validada junto com o usuário** (ex.: uma integração
nova testada de ponta a ponta, um bug real corrigido e confirmado,
uma seção nova de `docs/architecture.md` fechada) — **sem esperar o
usuário pedir toda vez**. Mensagens de commit devem ser descritivas
(o quê + por quê, não só "update"), seguindo o estilo dos commits já
existentes neste repo.

Não é pra comitar a cada Edit/Write isolado, nem trabalho parcial —
só quando o trabalho de uma tarefa (ou uma etapa clara dela) estiver
pronto e já tiver sido validado rodando de verdade, do jeito que este
projeto sempre validou cada integração (ver `docs/architecture.md`).
Na dúvida sobre se algo está "pronto pra commitar", trate como
pronto — o padrão aqui é commitar cedo e frequentemente, não acumular
mudanças grandes sem versionar.

`origin` aponta pra `https://github.com/ParisPS/SARAH.git`, branch
principal é `main`.

## Escopo do repositório git — cuidado

Este projeto vive em `/Users/parisps/Developer/jarvis` (o nome da
pasta no disco não foi renomeado pra "sarah", ver
`docs/architecture.md` → seção "Renomeação: JARVIS → SARAH"). Essa
pasta tem seu **próprio** `.git`, criado deliberadamente **aninhado**
dentro de outro repositório git que já existia, sem relação com este
projeto, com raiz em `/Users/parisps` (a HOME inteira do usuário) —
esse repo da HOME tem histórico e propósito completamente diferentes
(parece ligado a algum curso/ferramenta de design, nada a ver com
SARAH) e **não deve ser tocado** a partir daqui: nunca rode comandos
git com `cwd` fora de `/Users/parisps/Developer/jarvis` pensando que
está operando neste projeto. Sempre confirme com `git rev-parse
--show-toplevel` que aponta pra `.../jarvis` antes de comandos git
destrutivos, se houver qualquer dúvida.

## Segredos — nunca commitar

`.gitignore` já cobre `.env`, `data/` (audit log SQLite) e
`node_modules/`. O `refresh_token` do Gmail vive no Keychain do
macOS, nunca em arquivo (ver `packages/gmail/src/keychain.ts`). Antes
de qualquer commit que toque em configuração/env, rode `git status`
e confira a lista antes de `git add`.
