/**
 * Helper de variável de ambiente compartilhado entre client.ts e
 * auth-flow.ts — mesmo padrão de packages/notion/src/client.ts.
 */
export function getEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(
      `Variável de ambiente ${name} não definida. Configure-a no .env (veja .env.example).`
    );
  }
  return value;
}
