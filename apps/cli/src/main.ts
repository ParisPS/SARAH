import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

const { runSarah } = await import("@sarah/core");

runSarah().catch((err) => {
  console.error("Erro fatal:", err);
  process.exit(1);
});
