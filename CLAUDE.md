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

## Nunca tirar screenshot de tela inteira pra verificação/debug automatizado

`screencapture` (ou qualquer captura da tela inteira) NUNCA deve ser
usado como forma de verificar/debugar algo neste projeto, mesmo
parecendo o jeito mais direto de "ver" um resultado visual (ex.: um
dialog nativo do Electron). A tela do usuário pode ter QUALQUER outra
janela aberta no momento — editor com `.env` visível, terminal com
segredo impresso, outra conversa — e uma captura de tela inteira não
distingue isso do que se está tentando verificar. Incidente real
nesta fase (Fase 7 parte 3): uma tentativa de comparar visualmente o
dialog de risco médio vs. alto risco via `screencapture` acabou
capturando o VS Code do usuário com o `.env` aberto, credenciais reais
(Notion, Google, Voyage) visíveis em texto puro na captura — a imagem
foi apagada assim que percebido, mas o vazamento já tinha acontecido
dentro da conversa. A partir de agora: pra qualquer verificação que
dependa de VER algo na tela (dialog nativo, janela, o resultado visual
de uma mudança), a resposta certa é pedir pro USUÁRIO olhar e
descrever/confirmar — nunca capturar a tela sozinho, nem de uma janela
específica, nem da tela inteira.

## Nunca imprimir o VALOR de um segredo só pra checar se ele existe

Pra checar se uma credencial já está salva no Keychain (ex.:
`sarah-code-github-token`, `sarah-gmail-refresh-token`), NUNCA rode
`security find-generic-password`/`find-internet-password` (ou
equivalente) com a flag que IMPRIME a senha (`-w`) — mesmo truncando a
saída com `head -c N` achando que é "só uma olhadinha". Incidente real
(levantamento de otimização, item T1): tentando confirmar se
`github:auth` já estava configurado antes de decidir se era seguro
rodar `code.create_project` de verdade, rodei `security
find-generic-password ... -w | head -c 30` — os primeiros 30
caracteres de um Personal Access Token do GitHub (`ghp_` + 26 dos 36
caracteres do segredo) já são uma fração grande demais pra ser segura,
e apareceram em texto puro na conversa (ver `docs/architecture.md`
pro relato completo). Mesma classe de erro dos incidentes de
screenshot acima — verificar "isso existe?" de um jeito que expõe o
PRÓPRIO CONTEÚDO do que devia só ser confirmado. A partir de agora:
checar existência de um segredo salvo SEM a flag `-w` (o código de
saída do comando já diz se o item existe ou não, sem precisar ler o
valor nunca).
