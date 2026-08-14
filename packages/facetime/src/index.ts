import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { openFaceTimeVideoCall } from "./open-url.js";

/**
 * FaceTime (Fase 8) — dispara uma chamada de VÍDEO de verdade pelo app
 * nativo, via o esquema de URL `facetime://` (ver ./open-url.ts pro
 * porquê NUNCA `facetime-audio://`). Só INICIA a chamada — não atende
 * automaticamente (é sempre o app FaceTime real, com a UI real dele,
 * quem toca a partir daqui), não grava nem extrai conteúdo nenhum da
 * ligação. Equivalente a clicar no botão de vídeo num contato.
 *
 * Risco MÉDIO (Fase 7 parte 3, mesmo mecanismo — ver
 * `MEDIUM_RISK_TOOLS` em @sarah/permissions): diferente de
 * `code.run_command`, esta tool NÃO tem allowlist nenhuma — toda
 * chamada confirma, sem exceção. Não é sobre "comando seguro vs.
 * perigoso" (não existe um "alvo seguro" que dispense confirmar), é
 * sobre fricção proporcional: ligar de verdade pra alguém nunca deve
 * ser zero-fricção (mereceria mais que baixo risco), mas também não é
 * destrutivo/irreversível como `git push` ou enviar e-mail (não
 * mereceria o alarme de alto risco).
 */

const call = tool(
  "call",
  "Inicia uma chamada de VÍDEO via FaceTime (facetime://, NUNCA facetime-audio://) pro telefone ou " +
    "e-mail informado. Se o usuário só disser um NOME (ex.: \"liga pro Pedro\"), use " +
    "apple-contacts.find ANTES pra resolver um telefone/e-mail real — nunca invente um número. Se a " +
    "busca achar mais de um contato com nome parecido, pergunte ao usuário qual antes de ligar. Só " +
    "DISPARA o convite pelo app FaceTime nativo (equivalente a clicar no botão de vídeo num contato) — " +
    "não atende automaticamente, não grava nem extrai conteúdo da ligação. Risco MÉDIO: sempre confirma " +
    "antes de ligar de verdade pra alguém (sem allowlist — toda chamada confirma), mas com apresentação " +
    "mais leve que alto risco, já que não é uma ação destrutiva/irreversível.",
  {
    target: z.string().min(1).describe("telefone ou e-mail do contato a chamar, resolvido via apple-contacts.find se o usuário só deu o nome"),
  },
  async (args) => {
    try {
      await openFaceTimeVideoCall(args.target);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ ok: true, target: args.target, videoCallStarted: true }, null, 2),
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }) }],
      };
    }
  }
);

export const facetimeServer = createSdkMcpServer({
  name: "sarah-facetime",
  tools: [call],
});
