import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

/**
 * Script de autorização do GitHub (Fase 5 parte 3) — roda uma vez (ou
 * de novo se o token for revogado). Diferente do `gmail-auth.ts` (que
 * faz um fluxo OAuth completo com loopback+PKCE), aqui não tem app
 * OAuth nenhum pra registrar: um Personal Access Token CLÁSSICO,
 * escopo `repo`, gerado manualmente em
 * https://github.com/settings/tokens, colado aqui, validado com uma
 * chamada real (`GET /user`) e salvo no Keychain do macOS — nunca em
 * arquivo.
 *
 * Uso: `pnpm github:auth` (a partir da raiz do repo).
 */
const { saveGithubToken } = await import("@sarah/sandbox");

const rl = readline.createInterface({ input, output });
console.log("Autorização do GitHub pra criação de repositórios (Fase 5, sandbox de código).");
console.log("1. Abra https://github.com/settings/tokens/new");
console.log('2. Marque o escopo "repo" (Full control of private repositories).');
console.log("3. Gere o token e cole aqui embaixo.\n");

const token = (await rl.question("Cole o Personal Access Token: ")).trim();
rl.close();

if (!token) {
  console.error("Nenhum token colado — nada foi salvo.");
  process.exit(1);
}

saveGithubToken(token)
  .then(({ login }) => {
    console.log(`\nToken válido, salvo no Keychain. Autenticado como: ${login}`);
    console.log("A partir de agora, `code.create_project` cria um repositório novo no GitHub automaticamente.");
  })
  .catch((err) => {
    console.error("\nErro na autorização do GitHub:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
