import { createServer } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { getEnv } from "./env.js";
import { saveRefreshToken } from "./keychain.js";

/**
 * Autorização OAuth interativa, rodada uma vez (ou de novo se o
 * refresh token for revogado/expirar) via `pnpm gmail:auth`.
 *
 * Fluxo "loopback" (RFC 8252) — o recomendado pelo Google pra apps
 * instalados desde que o fluxo OOB (`urn:ietf:wg:oauth:2.0:oob`) foi
 * desativado em 2022: um servidor HTTP local recebe o redirect com o
 * `code`, sem precisar de nenhum servidor público. Porta `0` = o SO
 * escolhe uma porta livre, então nunca colide com nada já rodando.
 *
 * IMPORTANTE: o client OAuth no Google Cloud Console precisa ser do
 * tipo "Desktop app" (não "Web application") — só esse tipo permite
 * redirect automático pra qualquer porta em http://127.0.0.1:* sem
 * pré-cadastrar a URI exata. Se a troca do code por tokens falhar
 * com `redirect_uri_mismatch`, é essa a causa mais provável.
 */
const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

/**
 * Fase 1: só `gmail.readonly`. Fase 3 (ações de e-mail) precisou
 * ACRESCENTAR `gmail.compose`, não trocar — confirmado na documentação
 * oficial da API (não assumido): `gmail.compose` sozinho NÃO permite
 * ler mensagens (`users.messages.get` exige `gmail.readonly`,
 * `gmail.modify` ou `gmail.metadata` — `gmail.compose` não está nessa
 * lista), e `gmail.readonly` sozinho não permite criar rascunho
 * (`users.drafts.create`/`update` exigem `gmail.compose` ou
 * `gmail.modify`). `gmail.get_message` e `gmail.reply_draft` (que
 * precisa ler a mensagem original pra montar a resposta) exigem os
 * dois escopos juntos. Ver docs/architecture.md pra fonte e detalhes
 * completos, incluindo a limitação aceita: `gmail.compose` também
 * permite ENVIAR (não existe escopo mais restrito só-rascunho do lado
 * do Google) — a garantia de "nunca envia" é do nosso código
 * (client.ts só chama o endpoint de criar draft, nunca o de enviar),
 * não da permissão OAuth.
 */
const SCOPE = "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose";

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

interface CallbackResult {
  code: string;
  redirectUri: string;
}

function waitForCallback(clientId: string, codeChallenge: string, state: string): Promise<CallbackResult> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const error = url.searchParams.get("error");
      const returnedState = url.searchParams.get("state");
      const code = url.searchParams.get("code");

      res.setHeader("Content-Type", "text/html; charset=utf-8");

      if (error) {
        res.end(`<h1>Erro na autorização: ${error}</h1><p>Pode fechar esta aba.</p>`);
        server.close();
        reject(new Error(`Google devolveu erro na autorização: ${error}`));
        return;
      }
      if (!code || returnedState !== state) {
        res.end("<h1>Requisição inválida (state não bate ou sem code).</h1>");
        return;
      }

      res.end("<h1>Autorizado!</h1><p>Pode fechar esta aba e voltar ao terminal.</p>");
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close();
      resolve({ code, redirectUri: `http://127.0.0.1:${port}` });
    });

    server.on("error", reject);

    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address !== "object" || !address) {
        reject(new Error("Não consegui abrir o servidor local de callback do OAuth."));
        return;
      }
      const redirectUri = `http://127.0.0.1:${address.port}`;
      const authUrl = new URL(GOOGLE_AUTH_URL);
      authUrl.searchParams.set("client_id", clientId);
      authUrl.searchParams.set("redirect_uri", redirectUri);
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("scope", SCOPE);
      authUrl.searchParams.set("access_type", "offline");
      authUrl.searchParams.set("prompt", "consent");
      authUrl.searchParams.set("state", state);
      authUrl.searchParams.set("code_challenge", codeChallenge);
      authUrl.searchParams.set("code_challenge_method", "S256");

      console.log("Abrindo o navegador pra autorizar a SARAH a ler seu Gmail e gerenciar rascunhos...");
      console.log("Se não abrir sozinho, acesse:\n" + authUrl.toString() + "\n");
      spawn("open", [authUrl.toString()], { stdio: "ignore", detached: true }).unref();
    });
  });
}

export async function runInteractiveAuthFlow(): Promise<void> {
  const clientId = getEnv("GOOGLE_CLIENT_ID");
  const clientSecret = getEnv("GOOGLE_CLIENT_SECRET");

  const codeVerifier = base64url(randomBytes(32));
  const codeChallenge = base64url(createHash("sha256").update(codeVerifier).digest());
  const state = base64url(randomBytes(16));

  const { code, redirectUri } = await waitForCallback(clientId, codeChallenge, state);

  const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      code_verifier: codeVerifier,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  const tokenBody = (await tokenRes.json().catch(() => null)) as
    | { refresh_token?: string; error?: string; error_description?: string }
    | null;

  if (!tokenRes.ok) {
    const hint =
      tokenBody?.error === "redirect_uri_mismatch"
        ? " Provável causa: o client OAuth no Google Cloud Console não é do tipo \"Desktop app\"."
        : "";
    throw new Error(
      `Falha ao trocar o código por tokens (${tokenRes.status}): ` +
        `${tokenBody?.error_description ?? tokenBody?.error ?? "erro desconhecido"}.${hint}`
    );
  }
  if (!tokenBody?.refresh_token) {
    throw new Error(
      "Google não devolveu um refresh_token. Revogue o acesso da SARAH em " +
        "https://myaccount.google.com/permissions e rode `pnpm gmail:auth` de novo."
    );
  }

  await saveRefreshToken(tokenBody.refresh_token);
  console.log(
    `Refresh token salvo no Keychain do macOS (serviço "sarah-gmail-refresh-token"). Autorização concluída.`
  );
}
