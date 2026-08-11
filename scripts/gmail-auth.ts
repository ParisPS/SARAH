import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Script de autorização OAuth do Gmail — roda uma vez (ou de novo se
 * o refresh token for revogado/expirar). Mesmo padrão de
 * apps/cli/src/main.ts pra carregar o `.env` da raiz do monorepo
 * antes de qualquer import que leia GOOGLE_CLIENT_ID/SECRET.
 *
 * Uso: `pnpm gmail:auth` (a partir da raiz do repo).
 */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENV_PATH = join(REPO_ROOT, ".env");
if (existsSync(ENV_PATH)) {
  process.loadEnvFile(ENV_PATH);
}

const { runInteractiveAuthFlow } = await import("@sarah/gmail");

runInteractiveAuthFlow().catch((err) => {
  console.error("Erro na autorização do Gmail:", err);
  process.exit(1);
});
