import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import type { ConfirmFn } from "@sarah/permissions";

/**
 * Carrega o `.env` da raiz do monorepo ANTES de importar @sarah/core
 * (que por sua vez importa @sarah/notion, que lê NOTION_API_KEY/
 * NOTION_CALENDAR_DATABASE_ID de `process.env` assim que a tool é
 * chamada). Bug real encontrado validando a integração Notion: nada
 * neste projeto carregava `.env` pra `process.env` — o arquivo existia
 * mas nenhuma variável nova (fora ANTHROPIC_API_KEY, que o `claude`
 * subprocess pode pegar de outro lugar) chegava a ser lida de fato.
 *
 * Usa `process.loadEnvFile` (nativo do Node 20.12+/22, sem
 * dependência nova) em vez de um pacote `dotenv`. Resolve o caminho a
 * partir da localização deste arquivo-fonte (não do cwd), pra
 * funcionar igual rodando via `pnpm dev` da raiz ou direto de
 * `apps/cli`.
 */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const ENV_PATH = join(REPO_ROOT, ".env");
if (existsSync(ENV_PATH)) {
  process.loadEnvFile(ENV_PATH);
}

const { createSarahSession } = await import("@sarah/core");

/**
 * Implementação de `ConfirmFn` pro terminal — mesma pergunta/formato de
 * sempre (readline + "(s/n)"), só que agora vive AQUI, não dentro de
 * @sarah/permissions (ver Fase 4 em docs/architecture.md: o Gateway
 * deixou de assumir terminal, pra abrir espaço pra uma interface
 * gráfica confirmar do jeito dela — dialog nativo, não stdin/stdout;
 * ver `apps/menubar`). Comportamento idêntico ao de antes da
 * refatoração: mesmo texto do cabeçalho de risco, mesmo fallback pro
 * JSON cru quando não há `preview`.
 *
 * Fase 7 parte 3: `risk` distingue a apresentação — alto risco mantém
 * o cabeçalho dramático de sempre ("⚠️ ALTO RISCO"); médio risco pausa
 * e pergunta do mesmo jeito (nunca roda sem confirmar), mas com um
 * cabeçalho mais neutro, sem a palavra "risco" gritando — proporcional
 * ao que está em jogo, não ausência de fricção.
 */
const confirmViaTerminal: ConfirmFn = async (toolName, toolInput, preview, risk) => {
  const rl = readline.createInterface({ input, output });
  if (risk === "high") {
    console.log(`\n⚠️  Ação de ALTO RISCO solicitada: ${toolName}`);
  } else {
    console.log(`\n🟡 Confirmar ação: ${toolName}`);
  }
  console.log(preview ?? `   Entrada: ${JSON.stringify(toolInput)}`);
  const answer = await rl.question("   Confirmar execução? (s/n) ");
  rl.close();
  return answer.trim().toLowerCase() === "s";
};

/**
 * Loop do REPL de terminal — antes vivia dentro de `@sarah/core`
 * (`runSarah`), movido pra cá na Fase 4 parte 2: ler a próxima linha
 * de `stdin` e escrever a resposta em `stdout` é especificamente
 * terminal, não faz sentido em `@sarah/core` (que `apps/menubar`
 * também usa, com IPC em vez de `readline`). A sessão em si
 * (`createSarahSession`) é a mesma função, com o mesmo Gateway/audit
 * log/memória, usada pelos dois apps — só o "como pergunto e como
 * mostro a resposta" muda.
 */
async function main(): Promise<void> {
  const session = createSarahSession({ confirm: confirmViaTerminal });

  const rl = readline.createInterface({ input, output });
  console.log("SARAH (Fase 4) — digite algo, ou 'sair' pra encerrar.");
  console.log(
    "Experimente: 'me dê um ping com a mensagem oi', 'finja apagar o arquivo teste.txt', " +
      "'liste meus eventos de hoje', 'marca um compromisso amanhã às 15h' (vai pro Notion, " +
      "o calendário principal), 'cria um evento no Apple Calendar amanhã às 15h', " +
      "'cria um lembrete pra ligar pro dentista', 'resuma meus e-mails de hoje', " +
      "'lembra que...' (guarda uma preferência ou fato), 'o que você sabe sobre mim?', " +
      "'lista minhas notas', 'cria uma nota com...', 'envia o rascunho <id>' (pede confirmação), " +
      "'busca o contato do Fulano' ou 'liga por vídeo pro Fulano' (FaceTime, pede confirmação leve), " +
      "'quanto custa uma Air Fryer 4L' (busca preços reais na web)\n"
  );

  try {
    while (true) {
      let prompt: string;
      try {
        prompt = await rl.question("> ");
      } catch (err) {
        // O stdin fechou (ex.: EOF por pipe, ou Ctrl+D) enquanto o
        // loop ainda esperava a próxima pergunta — readline/promises
        // rejeita `question()` nesse caso em vez de só devolver vazio.
        // Trata como "sair" em vez de derrubar o processo com stack
        // trace.
        if (err instanceof Error && err.message.includes("readline was closed")) break;
        throw err;
      }
      if (prompt.trim().toLowerCase() === "sair") break;
      if (!prompt.trim()) continue;

      // FASE 4 PARTE 3: `ask()` passou a emitir `SarahEvent` (texto +
      // avisos de tool usada, ver @sarah/core) em vez de só texto —
      // `apps/menubar` usa os eventos de tool pro selo discreto sob
      // cada resposta; o terminal ignora esses eventos de propósito,
      // mantendo a saída idêntica à de antes desta mudança.
      for await (const event of session.ask(prompt)) {
        if (event.type === "text") process.stdout.write(event.text);
      }
      console.log("\n");
    }
  } finally {
    rl.close();
    // Fase 5: `close()` virou async (espera containers de projeto
    // pararem de verdade) — precisa de `await` antes do processo
    // encerrar, senão um container podia ficar órfão.
    await session.close();
  }
}

main().catch((err) => {
  console.error("Erro fatal:", err);
  process.exit(1);
});
