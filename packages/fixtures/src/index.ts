import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

/**
 * Duas tools "de brinquedo", só pra validar o pipeline completo
 * (agente → Gateway → execução → audit log) sem tocar em nada real:
 *
 *  - ping           → baixo risco, roda direto
 *  - pretend_delete → alto risco, dispara a confirmação no terminal
 *                      (não apaga nada de verdade, é só simulação)
 *
 * Quando a Fase 1 começar, o primeiro tool real (Apple Calendar) segue
 * exatamente este mesmo formato — troca só o `execute`.
 */

const ping = tool(
  "ping",
  "Responde 'pong' — usada só para validar que o agente consegue chamar uma tool.",
  { message: z.string().describe("mensagem de teste enviada junto com o ping") },
  async (args) => ({
    content: [
      { type: "text", text: `pong: ${args.message} (${new Date().toISOString()})` },
    ],
  })
);

const pretendDelete = tool(
  "pretend_delete",
  "FINGE apagar um arquivo (não apaga nada de verdade) — usada só para validar o fluxo de confirmação de alto risco do Gateway.",
  { path: z.string().describe("caminho que 'seria' apagado") },
  async (args) => ({
    content: [
      {
        type: "text",
        text: `(simulado) ${args.path} seria apagado aqui — nada foi apagado de verdade.`,
      },
    ],
  })
);

export const fixturesServer = createSdkMcpServer({
  name: "sarah-fixtures",
  tools: [ping, pretendDelete],
});
