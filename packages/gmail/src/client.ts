import { getEnv } from "./env.js";
import { getRefreshToken } from "./keychain.js";

/**
 * Chamadas cruas à API REST do Gmail (sem SDK oficial `googleapis`
 * como dependência — só `fetch` global do Node, mesmo espírito leve
 * de packages/notion/src/client.ts).
 */
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

interface TokenErrorBody {
  error?: string;
  error_description?: string;
}

function buildAuthError(status: number, body: TokenErrorBody | null): Error {
  if (body?.error === "invalid_grant") {
    return new Error(
      "Refresh token do Gmail inválido, expirado ou revogado. Rode `pnpm gmail:auth` de novo pra reautorizar."
    );
  }
  return new Error(
    `Erro ao renovar o access token do Gmail (${status}): ${body?.error_description ?? body?.error ?? "erro desconhecido"}`
  );
}

/**
 * Troca o refresh token (guardado no Keychain) por um access token
 * novo. SEM cache — renovado a cada chamada. Mesma lição já registrada
 * no docs/architecture.md sobre o bug de cache do schema do Notion: o
 * custo de uma chamada HTTP extra é desprezível pra um assistente
 * pessoal, e cache é a classe de bug mais fácil de introduzir por
 * engano (schema/token ficam "presos" no valor antigo até reiniciar).
 */
async function getAccessToken(): Promise<string> {
  const clientId = getEnv("GOOGLE_CLIENT_ID");
  const clientSecret = getEnv("GOOGLE_CLIENT_SECRET");
  const refreshToken = await getRefreshToken();

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const body = (await res.json().catch(() => null)) as (TokenErrorBody & { access_token?: string }) | null;

  if (!res.ok || !body?.access_token) {
    throw buildAuthError(res.status, body);
  }
  return body.access_token;
}

interface GmailApiErrorBody {
  error?: { message?: string; errors?: Array<{ reason?: string }> };
}

function buildApiError(status: number, body: GmailApiErrorBody | null): Error {
  const message = body?.error?.message ?? "erro desconhecido";
  const reason = body?.error?.errors?.[0]?.reason;

  if (status === 403 && (reason === "accessNotConfigured" || /has not been used|not been enabled/i.test(message))) {
    return new Error(
      "A Gmail API não parece estar habilitada no seu projeto do Google Cloud. " +
        "Habilite em console.cloud.google.com → APIs e serviços → Biblioteca → Gmail API. " +
        `Mensagem original: ${message}`
    );
  }

  return new Error(`Gmail API respondeu ${status}: ${message}`);
}

async function gmailFetch(path: string): Promise<any> {
  const accessToken = await getAccessToken();
  const res = await fetch(`${GMAIL_API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw buildApiError(res.status, body);
  }
  return body;
}

export interface RecentEmail {
  id: string;
  from: string;
  subject: string;
  date: string;
  snippet: string;
}

export interface ListRecentEmailsInput {
  query?: string;
  maxResults?: number;
}

/**
 * Lista e-mails recentes (SOMENTE metadados: From/Subject/Date +
 * `snippet` — o preview curto que a API já inclui em qualquer format
 * exceto `raw`). Não busca o corpo completo de cada e-mail: é
 * suficiente pra resumir, e mais barato/privado que puxar tudo.
 */
export async function listRecentEmails(input: ListRecentEmailsInput = {}): Promise<RecentEmail[]> {
  const query = input.query?.trim() || "newer_than:1d";
  const maxResults = Math.min(Math.max(input.maxResults ?? 15, 1), 50);

  const list = await gmailFetch(`/messages?q=${encodeURIComponent(query)}&maxResults=${maxResults}`);
  const ids = ((list.messages ?? []) as Array<{ id: string }>).map((m) => m.id);

  const emails = await Promise.all(
    ids.map(async (id): Promise<RecentEmail> => {
      const msg = await gmailFetch(
        `/messages/${id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`
      );
      const headers = Object.fromEntries(
        ((msg.payload?.headers ?? []) as Array<{ name: string; value: string }>).map((h) => [h.name, h.value])
      );
      return {
        id,
        from: headers.From ?? "(desconhecido)",
        subject: headers.Subject ?? "(sem assunto)",
        date: headers.Date ?? "",
        snippet: msg.snippet ?? "",
      };
    })
  );

  return emails;
}
