import { query } from "@anthropic-ai/claude-agent-sdk";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { createGateway } from "@sarah/permissions";
import { AuditLog } from "@sarah/audit";
import { fixturesServer } from "@sarah/fixtures";
import { appleCalendarServer } from "@sarah/apple-calendar";
import { notionServer } from "@sarah/notion";
import { appleRemindersServer } from "@sarah/apple-reminders";
import { gmailServer } from "@sarah/gmail";

/**
 * Loop principal do REPL de terminal que fala com o Claude Agent SDK,
 * passando pelo Gateway de permissões e registrando tudo no audit
 * log. Estrutura criada na Fase 0; a partir da Fase 1 as tools de
 * fixtures continuam registradas (servem de sanity check) e passam a
 * dividir espaço com integrações reais: @sarah/apple-calendar,
 * @sarah/notion, @sarah/apple-reminders e @sarah/gmail. As duas
 * primeiras têm uma tool `create_event` — a desambiguação entre elas
 * (Notion é o calendário principal/padrão, Apple só quando pedido
 * explicitamente, nunca as duas juntas) vive inteiramente nas
 * `description` de cada tool, não aqui — é o único sinal que o agente
 * tem pra escolher entre tools do MCP. Reminders é um app diferente
 * (lembrete, não compromisso/evento), então não compete com as duas —
 * mas a distinção também é feita só via description, mesmo mecanismo.
 * Gmail (leitura) não compete com nenhuma delas, mas tem seu próprio
 * concorrente: o conector nativo `claude_ai_Gmail` do ambiente, que é
 * bloqueado abaixo via `disallowedTools` — a SARAH usa exclusivamente
 * sua própria tool, que passa pelo Gateway e pelo audit log.
 *
 * IMPORTANTE: as tools de teste NÃO entram em `allowedTools`. Nesse
 * SDK, um nome "solto" em `allowedTools` pré-aprova a tool inteira —
 * o `canUseTool` (nosso Gateway) nem chega a ser chamado pra ela. A
 * gente descobriu isso na prática: o SDK emite um warning
 * (CLAUDE_SDK_CAN_USE_TOOL_SHADOWED) avisando exatamente isso.
 * Deixando as tools de fora de `allowedTools`, toda chamada "cai" no
 * `canUseTool` normalmente — que é o comportamento que a gente quer.
 *
 * `disallowedTools` bloqueia de vez as tools nativas do agente
 * (Bash, Write, Edit etc.) — nada disso deve existir antes do sandbox
 * da Fase 5. Mesmo que algum nome aqui não bata 100% com a versão do
 * SDK instalada, qualquer tool não reconhecida cai no Gateway e é
 * classificada como alto risco por padrão (ver `classifyRisk` em
 * @sarah/permissions) — ou seja, o pior caso é pedir confirmação a
 * mais, nunca executar em silêncio.
 */
const BUILTIN_TOOLS_TO_BLOCK = [
  "Bash",
  "Read",
  "Write",
  "Edit",
  "NotebookEdit",
  "Glob",
  "Grep",
  "WebSearch",
  "WebFetch",
  "Task",
  // Conector nativo do Gmail do claude.ai — decisão explícita: a SARAH
  // usa exclusivamente sua própria tool `gmail.list_recent_emails`
  // (OAuth próprio via GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET, ver
  // packages/gmail), nunca esse conector, mesmo que ele apareça
  // disponível no ambiente. O glob bloqueia toda a namespace, não só
  // a tool específica que já apareceu (search_threads) — qualquer
  // outra tool que esse conector exponha (get_message, list_labels
  // etc.) cai no mesmo bloqueio.
  "mcp__claude_ai_Gmail__*",
];

export async function runSarah(): Promise<void> {
  const audit = new AuditLog("./data/sarah.db");
  const canUseTool = createGateway({ onDecision: (entry) => audit.record(entry) });

  const rl = readline.createInterface({ input, output });
  console.log("SARAH (Fase 1) — digite algo, ou 'sair' pra encerrar.");
  console.log(
    "Experimente: 'me dê um ping com a mensagem oi', 'finja apagar o arquivo teste.txt', " +
      "'liste meus eventos de hoje', 'marca um compromisso amanhã às 15h' (vai pro Notion, " +
      "o calendário principal), 'cria um evento no Apple Calendar amanhã às 15h', " +
      "'cria um lembrete pra ligar pro dentista' ou 'resuma meus e-mails de hoje'\n"
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

      const stream = query({
        prompt,
        options: {
          mcpServers: {
            "sarah-fixtures": fixturesServer,
            "sarah-apple-calendar": appleCalendarServer,
            "sarah-notion": notionServer,
            "sarah-apple-reminders": appleRemindersServer,
            "sarah-gmail": gmailServer,
          },
          disallowedTools: BUILTIN_TOOLS_TO_BLOCK,
          canUseTool,
        },
      });

      for await (const message of stream) {
        if (message.type === "assistant") {
          for (const block of message.message.content) {
            if (block.type === "text") process.stdout.write(block.text);
          }
        }
      }
      console.log("\n");
    }
  } finally {
    rl.close();
    audit.close();
  }
}
