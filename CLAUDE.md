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

## Mudanças em `packages/core`/`packages/permissions` — avisar sobre reiniciar o menu bar

O app de menu bar (`apps/menubar`) sobe um processo filho ("daemon",
`apps/menubar/src/daemon.ts`) UMA ÚNICA VEZ quando o app abre
(`spawnSarahDaemon` em `main-process.ts`), e reusa esse mesmo processo
pra toda chamada de `ask()`/`dashboard()` daquela sessão — nunca é
respawnado por pedido. Esse processo roda via `tsx`, que só lê o
código-fonte no instante em que o processo NASCE: um daemon já em
execução não passa a enxergar uma mudança de código feita no disco
depois, mesmo com commit/push novo. `apps/cli`, por outro lado, sobe
um processo novo a cada `pnpm dev`, então não sofre desse problema.

Por isso, toda vez que uma mudança tocar `packages/core` ou
`packages/permissions` (código que roda DENTRO do daemon), avise
explicitamente no fim da resposta que o app de menu bar precisa ser
fechado e reaberto pra a mudança valer de verdade — sem isso, o
usuário pode testar a mudança nova contra uma sessão que ainda está
rodando código antigo, sem perceber. Isso já causou confusão real
numa sessão (Fase 7 parte 2, observabilidade: chamadas do Figma
pareciam não capturadas pela correção nova, mas eram só o daemon
antigo ainda rodando) — vale prevenir de se repetir.

## Segredos — nunca commitar

`.gitignore` já cobre `.env`, `data/` (audit log SQLite) e
`node_modules/`. O `refresh_token` do Gmail vive no Keychain do
macOS, nunca em arquivo (ver `packages/gmail/src/keychain.ts`). Antes
de qualquer commit que toque em configuração/env, rode `git status`
e confira a lista antes de `git add`.
