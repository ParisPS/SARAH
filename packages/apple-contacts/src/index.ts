import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { runContactsBridge } from "./bridge.js";

/**
 * Apple Contacts via JXA (`Application("Contacts")`) — mesmo padrão
 * externo dos outros pacotes Apple (tool() + createSdkMcpServer, ponte
 * JXA em ./bridge.ts). Peça nova da Fase 8 (FaceTime): existe pra
 * resolver "ligue pro Pedro" num telefone/e-mail de verdade antes de
 * `facetime.call` (`@sarah/facetime`) conseguir montar a URL
 * `facetime://`.
 *
 * Escopo travado de propósito: só BUSCA por nome (`find`) — sem criar/
 * editar/apagar contato nenhum, isso nunca foi pedido e não tem
 * necessidade óbvia pro caso de uso (ligar por FaceTime). Baixo risco:
 * leitura pura, sem efeito colateral possível.
 */

const find = tool(
  "find",
  "Busca contatos do app Contatos da Apple cujo NOME contém o texto buscado (case-insensitive, substring — " +
    "não precisa ser o nome exato), devolvendo telefone(s) e e-mail(s) de cada um. Leitura pura, baixo " +
    "risco. Use antes de `facetime.call` quando o usuário só disser o nome da pessoa (ex.: \"liga pro " +
    "Pedro\") — passe o telefone ou e-mail encontrado aqui pra lá, nunca invente um número. Se a busca " +
    "devolver mais de um contato, confirme com o usuário QUAL antes de ligar.",
  {
    query: z.string().min(1).describe("texto a buscar no nome do contato"),
    limit: z.number().int().positive().max(50).optional().describe("máximo de contatos a retornar (padrão 10)"),
  },
  async (args) => {
    const result = await runContactsBridge({ command: "find", ...args });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

export const appleContactsServer = createSdkMcpServer({
  name: "sarah-apple-contacts",
  tools: [find],
});

export { checkContactsStatus } from "./status.js";
