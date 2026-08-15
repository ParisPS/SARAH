# Dicas práticas — SARAH

Lições reais encontradas construindo e validando cada fase deste
projeto, em formato rápido de consultar: "se X acontecer, provavelmente
é Y". Para o relato completo de cada achado (por que aconteceu, como
foi investigado, o que foi tentado) ver
[`docs/architecture.md`](architecture.md) — este arquivo é só o
resumo acionável. Diferente do `README.md`, aqui uma decisão
abandonada PODE aparecer, se a lição técnica por trás dela for útil
(ex.: WhatsApp foi abandonado como capacidade, mas a lição sobre
libs não-oficiais de mensageria continua valendo).

## Ambiente / processos

- **Mudou algo em `packages/core` ou `packages/permissions` e o
  comportamento não mudou no app de menu bar?** O daemon
  (`apps/menubar/src/daemon.ts`) sobe UMA vez quando o app abre e nunca
  é respawnado — roda via `tsx`, que só lê o código-fonte no instante
  em que nasce. Feche e reabra o app de menu bar. `apps/cli` não sofre
  disso (processo novo a cada `pnpm dev`).
- **`git status`/comandos git nesta pasta se comportando estranho, ou
  medo de rodar algo destrutivo?** O repo vive em
  `/Users/parisps/Developer/jarvis`, aninhado DENTRO de outro repositório
  git (raiz em `/Users/parisps`, sem relação com este projeto). Confirme
  `git rev-parse --show-toplevel` aponta pra `.../jarvis` antes de
  qualquer comando destrutivo.
- **Precisa "ver" um resultado visual (dialog, janela, mudança de
  layout) pra confirmar que funcionou?** Nunca `screencapture`/screenshot
  de tela inteira — já vazou credenciais reais DUAS vezes neste projeto
  (outra janela aberta no fundo). Sempre peça pro usuário olhar e
  descrever.
- **Precisa só CHECAR SE um segredo já está salvo no Keychain (não ler
  o valor)?** Nunca rode `security find-generic-password ... -w`
  (mesmo truncando a saída) — a flag `-w` imprime a senha crua. Já
  vazou parte de um token real do GitHub assim (30 caracteres de um
  Personal Access Token, truncados achando que era seguro). Confirme
  existência pelo código de saída do comando, sem a flag `-w`.
- **`tsx watch` reiniciando o processo sozinho sem motivo aparente?**
  O audit log grava em `data/sarah.db`, dentro da própria pasta
  observada — cada tool call vira uma mudança de arquivo que dispara
  reload. Por isso `pnpm dev` não usa watch mode.
- **Electron não abre nenhuma janela, só roda como processo Node
  puro?** `ELECTRON_RUN_AS_NODE=1` provavelmente está setado no shell —
  precisa `env -u ELECTRON_RUN_AS_NODE` antes de invocar o binário do
  Electron (já resolvido no script `dev` de `apps/menubar`).
- **FPS baixo/travamento no holograma (Three.js) sem ter mudado nada
  gráfico?** Antes de suspeitar de regressão de código, confira
  processos Electron ÓRFÃOS de testes anteriores ainda rodando e
  competindo por GPU (`ps aux | grep Electron`) — aconteceu mais de
  uma vez e nunca foi o código.
- **Rodando um script de teste automatizado contra o app enquanto o
  usuário pode estar usando ele ao vivo?** Não. Um listener global de
  evento (ex.: confirmação pendente) pode interceptar e responder uma
  decisão REAL do usuário sem ele perceber — já aconteceu. Só rode
  scripts de automação contra uma instância isolada, nunca a que o
  usuário pode estar usando.

## Permissões / Gateway

- **Uma tool nova parece estar rodando sem passar pela confirmação
  esperada?** Confira se o nome dela não foi parar em `allowedTools` —
  isso PRÉ-APROVA e pula o `canUseTool` (Gateway) inteiro; o SDK avisa
  com `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` no stderr. Nenhuma tool deste
  projeto deve entrar ali.
- **`ToolSearch` (mecanismo interno do Agent SDK pra resolver tools
  "adiadas", ativado quando a lista de tools registradas cresce) some
  do audit log mesmo tendo rodado?** Achado real, confirmado mais de
  uma vez (Fase 5 parte 2 e Fase 9): essa tool específica NÃO passa
  pelo Gateway — nenhuma linha é gravada pra ela. Ainda sem correção
  aplicada, registrado como pendência.
- **`AskUserQuestion` (a tool nativa do SDK) pedindo confirmação de
  alto risco mesmo parecendo "só uma pergunta"?** Esperado — ela passa
  pelo mesmo Gateway de qualquer outra tool, confirmado testando de
  verdade.
- **Allowlist de comando/URL parecendo segura mas com uma brecha?**
  Desconfie de checagem por PREFIXO (`ls; rm -rf .` começa com `ls`) —
  a correção real é bloquear qualquer metacaractere de encadeamento de
  shell (`;`, `&&`, `||`, `|`, backtick, `$(...)`, `>`, `<`), não tentar
  prever cada comando perigoso.

## Apple (JXA / EventKit / Contacts)

- **Xcode Command Line Tools quebrado e sem vontade de compilar uma
  ponte nativa?** JXA (`osascript -l JavaScript`) acessa EventKit,
  Reminders, Notes e Contacts sem compilar nada — mesmo padrão usado
  em todas as integrações Apple deste projeto.
- **Apple Notes**: título e primeira linha do corpo são o MESMO campo
  internamente, e o corpo é HTML de verdade, não texto plano — trate
  como tal.
- **Apple Contacts reportando "não configurado" mesmo com a busca
  funcionando?** Existem DOIS gates de permissão separados:
  `CNContactStore` (framework nativo, pode nunca ter sido autorizado) e
  `Application("Contacts")` via Automation/Apple Events (o caminho que
  este projeto usa, já autorizado desde o Notes). Checar o gate ERRADO
  reporta status incorreto mesmo com tudo funcionando.
- **Telefone/e-mail de contato vindo com rótulo ilegível tipo
  `_$!<Mobile>!$_`?** Formato interno do AddressBook — precisa limpar
  com regex antes de mostrar (`cleanLabel()` em `apple-contacts`).
- **`facetime://` não dispara a chamada sem um clique manual final?**
  Não é bug nem limitação deste projeto — o macOS SEMPRE exige esse
  clique, é proteção deliberada do sistema contra redirecionamento
  malicioso de chamada. Confirmado na documentação oficial da Apple,
  sem brecha técnica conhecida.

## Voz (whisper.cpp / sox / say)

- **Gravação de áudio via CLI travando ou corrompendo o `.wav`?**
  `whisper-stream` (binário do próprio whisper.cpp) trava no
  dispositivo de captura padrão nesta configuração (tenta o microfone
  de Continuidade do iPhone) e corrompe o arquivo se morto com sinal
  abrupto. Use `sox`/`rec` com o efeito `silence` embutido, e pare com
  SIGINT (nunca SIGKILL/SIGTERM) pra finalizar o cabeçalho do `.wav`
  direito.
- **Binário (`whisper-cli`, `rec`, `say`) não encontrado quando o app
  roda empacotado/fora de um terminal?** Um app Electron lançado fora
  de terminal pode ter um `PATH` mínimo sem `/opt/homebrew/bin`. Sempre
  resolva caminho ABSOLUTO primeiro, com fallback pro nome solto.
- **TTS soletrando URL/caminho de arquivo letra por letra?** Sanitize o
  texto ANTES de mandar pro `say` (substitua link/caminho/identificador
  longo por uma palavra genérica) — nunca deixe o modelo "lembrar" de
  resumir sozinho.
- **Toggle de idioma muda a VOZ mas o texto sai no idioma errado?** O
  toggle PT/EN só troca a voz do TTS por padrão — o TEXTO da resposta
  precisa ser instruído via `systemPrompt` toda vez, senão o modelo
  escolhe o idioma sozinho (geralmente o do pedido).
- **`pip install` falhando com "externally-managed-environment"?**
  Homebrew Python (PEP 668) bloqueia instalar pacote direto no sistema.
  Sempre crie um venv isolado (`python3 -m venv`) — nunca use
  `--break-system-packages`.
- **openWakeWord (ou qualquer lib que dependa de `tflite_runtime`)
  falhando ao carregar no macOS?** `tflite_runtime` não tem build fácil
  pra Apple Silicon — force `inference_framework="onnx"` (o `Model` já
  tenta cair pra ONNX sozinho se os dois formatos existirem em disco,
  mas o componente de VAD precisa do onnx explícito).
- **`sox`/`rec` nunca para sozinho mesmo com o efeito `silence`
  configurado?** Confira se o processo tem acesso real ao microfone —
  rodar `rec` num processo/terminal sem permissão de microfone real
  produz `In:0.00%` pra sempre (silêncio nunca é "quebrado" pra
  começar a contar), então o efeito nunca dispara. Não assuma que é o
  threshold errado sem checar isso primeiro.

## Sandbox de código (Podman)

- **Limpeza de container órfão parece ter matado um projeto que ainda
  estava em uso?** Cheque liveness REAL (PID + dono), não só a
  existência do container — um processo pode ter saído sem limpar, mas
  outro processo LEGÍTIMO pode ainda estar usando o mesmo container.
- **Reabrir um projeto que já tem commits quebra com erro de
  filesystem/SELinux?** A flag `:Z` (relabeling) no mount não é segura
  de reusar em todo remount — foi removida do caminho de "reabrir
  projeto existente".
- **`security -w` (Keychain) devolvendo um segredo estranho, cheio de
  caracteres tipo `\253\301...`?** Segredo multi-linha/binário volta
  como HEX, não texto puro — precisa decodificar antes de usar.
- **App de menu bar fechando mas deixando um container Podman
  rodando?** `before-quit` precisa interceptar a primeira tentativa de
  sair e esperar o `stop()` assíncrono de verdade — `SIGTERM` não
  dispara `process.on("SIGTERM")` de forma confiável no processo
  principal do Electron (bug conhecido do próprio Electron).

## APIs externas (Notion / Figma / Gmail / provedores de busca)

- **Notion: nome de propriedade "errado" (banco usa "Name"/"Date" em
  vez de "Título"/"Data")?** Nomes de propriedade em bancos Notion são
  arbitrários — detecte pelo TIPO da propriedade (`title`/`date`), nunca
  por nome fixo.
- **`NOTION_CALENDAR_DATABASE_ID` "não funciona" mesmo colado
  certinho?** Usuário costuma colar a URL inteira do banco, não só o
  UUID — extraia o UUID de dentro da string em vez de exigir o formato
  exato.
- **Figma: `styleType` (camelCase) não bate com o que a API devolve?**
  A API REST do Figma é inconsistente entre endpoints — alguns campos
  vêm `snake_case` (`style_type`). Confira o payload real, não assuma
  pelo nome do outro endpoint.
- **Figma: erro 429 sem `X-Figma-Rate-Limit-Type` no header?** O rate
  limit do plano gratuito é provavelmente MENSAL (não por minuto) — o
  header nem sempre vem preenchido, mas o padrão de "poucas chamadas
  totais estouram rápido" é o sinal real.
- **Gmail: `get_message`/API retornando erro estranho de escopo?**
  `gmail.compose` sozinho NÃO permite ler mensagens — precisa dos dois
  escopos (`gmail.readonly` + `gmail.compose`) juntos pra ciclo
  completo de leitura+rascunho.
- **Bing Search API ou Google Custom Search JSON API "sumiram" da
  documentação/não aceitam conta nova?** Confirmado pesquisando (não
  assuma que uma API "clássica" continua disponível): Bing Search API
  foi aposentada pela Microsoft (2025); Google Custom Search JSON API
  está fechada pra clientes NOVOS desde 2026.
- **Tentando automatizar WhatsApp pessoal sem a API oficial (Cloud
  API)?** Não — biblioteca não-oficial que emula o app cliente viola os
  termos de uso do WhatsApp, com risco real de banimento do número.
  Mesmo a API oficial (que este projeto chegou a implementar e depois
  abandonou por outros motivos) exige número de negócio SEPARADO do
  pessoal.
- **WhatsApp Cloud API aceitando o envio (`200`, `messageId` real) mas
  a mensagem nunca chega no aparelho?** "Aceito pela API" não é o
  mesmo que "entregue" — sem um webhook configurado, não existe
  visibilidade nenhuma sobre falha de entrega depois do envio síncrono.

## Memória semântica (sqlite-vec / Voyage)

- **`memory.forget` falhando silenciosamente com `no such module:
  vec0`?** A extensão `sqlite-vec` carrega POR CONEXÃO, mas um trigger
  SQL de limpeza fica gravado no ESQUEMA do arquivo `.db` pra sempre —
  uma conexão sem a extensão tenta rodar o trigger legado e quebra.
  Nunca dependa de trigger SQL pra lógica que precisa da extensão;
  faça a limpeza em código (best-effort).
- **Busca semântica falhando ocasionalmente sob uso mais pesado?**
  Sem cartão de pagamento cadastrado na Voyage AI, o limite é de só 3
  requisições por MINUTO — degrada pra busca por palavra-chave (FTS5)
  automaticamente, não é um bug.

## Observabilidade / erros

- **Painel "Erros recentes" vazio mesmo sabendo que algo falhou de
  verdade?** A maioria das tools deste projeto captura o próprio erro
  e devolve `{ok: false, error}` como resposta NORMAL (convenção do
  projeto, pro agente conseguir reagir) — isso não dispara
  `PostToolUseFailure` (só exceção não capturada dispara, raro).
  Precisa parsear o CONTEÚDO da resposta, não só escutar o hook de
  falha.
- **Erro real no audit log aparecendo com `status`/`error_message`
  vazios mesmo depois de corrigir o código?** Confira se não é o
  DAEMON antigo ainda rodando (ver primeira dica deste arquivo) antes
  de suspeitar de bug novo — já aconteceu de investigar um "bug" que
  na real era sessão obsoleta.
