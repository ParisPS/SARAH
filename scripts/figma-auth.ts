import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

/**
 * Script de autorização do Figma (Fase 5 parte 6) — mesmo padrão do
 * `github-auth.ts`: um Personal Access Token (não OAuth, mais simples,
 * checado contra a documentação oficial atual do Figma antes de
 * implementar), gerado manualmente pelo usuário, colado aqui, validado
 * com uma chamada real (`GET /v1/me`) e salvo no Keychain do macOS.
 *
 * Uso: `pnpm figma:auth` (a partir da raiz do repo).
 */
const { saveFigmaToken } = await import("@sarah/sandbox");

const rl = readline.createInterface({ input, output });
console.log("Autorização do Figma pra extração de assets (Fase 5, sandbox de código).");
console.log("1. Abra o Figma → menu da conta (canto superior esquerdo) → Configurações → aba Security.");
console.log('2. Em "Personal access tokens", clique em "Generate new token".');
console.log('3. Marque os escopos "File content" (file_content:read) e "Current user" (current_user:read).');
console.log("4. Gere o token e cole aqui embaixo.\n");

const token = (await rl.question("Cole o Personal Access Token: ")).trim();
rl.close();

if (!token) {
  console.error("Nenhum token colado — nada foi salvo.");
  process.exit(1);
}

saveFigmaToken(token)
  .then(({ handle }) => {
    console.log(`\nToken válido, salvo no Keychain. Autenticado como: ${handle}`);
    console.log("A partir de agora, `figma.export_assets` pode ler arquivos do Figma e exportar assets.");
  })
  .catch((err) => {
    console.error("\nErro na autorização do Figma:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
