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

async function gmailFetch(path: string, init: RequestInit = {}): Promise<any> {
  const accessToken = await getAccessToken();
  const res = await fetch(`${GMAIL_API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
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

// ---------------------------------------------------------------------
// Fase 3: leitura de corpo completo (get_message) e rascunhos
// (create_draft / reply_draft). NUNCA chama o endpoint de enviar — só
// /messages (leitura) e /drafts (criação). Ver docs/architecture.md
// pra decisão registrada sobre o escopo gmail.compose (também permite
// enviar do lado da API do Google; a garantia de "nunca envia" é
// deste código, não da permissão OAuth).
// ---------------------------------------------------------------------

function base64UrlDecode(data: string): string {
  const normalized = data.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized, "base64").toString("utf-8");
}

function base64Url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

interface GmailMessagePart {
  mimeType?: string;
  body?: { data?: string };
  parts?: GmailMessagePart[];
}

/** Busca em profundidade pela primeira parte MIME de um tipo específico. */
function findPartByMimeType(part: GmailMessagePart, mimeType: string): string | null {
  if (part.mimeType === mimeType && part.body?.data) {
    return base64UrlDecode(part.body.data);
  }
  if (part.parts) {
    for (const sub of part.parts) {
      const found = findPartByMimeType(sub, mimeType);
      if (found !== null) return found;
    }
  }
  return null;
}

/**
 * Conversão HTML→texto BEM simples (só fallback, quando o e-mail não
 * tem parte text/plain — alguns e-mails só mandam text/html). Não
 * tenta preservar formatação, só extrair texto legível: fora do
 * escopo "texto simples" tentar renderizar HTML de verdade.
 */
function stripHtml(html: string): string {
  return html
    .replace(/<(br|\/p|\/div|\/tr)\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** text/plain se existir; senão text/html convertido (best-effort); senão um aviso. */
function extractBody(payload: GmailMessagePart): string {
  const plain = findPartByMimeType(payload, "text/plain");
  if (plain !== null) return plain;
  const html = findPartByMimeType(payload, "text/html");
  if (html !== null) return stripHtml(html);
  return "(sem corpo em texto disponível pra este e-mail)";
}

export interface FullEmail {
  id: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  body: string;
}

/**
 * Corpo completo de UM e-mail específico, sob demanda — diferente de
 * `listRecentEmails` (só metadados/snippet, ver comentário lá). Busca
 * `format=full` só quando o agente realmente precisa do conteúdo
 * inteiro (ex.: pra responder), não em toda listagem — mesmo
 * princípio de minimizar dado puxado da Fase 1.
 */
export async function getMessage(messageId: string): Promise<FullEmail> {
  const msg = await gmailFetch(`/messages/${messageId}?format=full`);
  const headers = Object.fromEntries(
    ((msg.payload?.headers ?? []) as Array<{ name: string; value: string }>).map((h) => [h.name, h.value])
  );
  return {
    id: msg.id,
    threadId: msg.threadId,
    from: headers.From ?? "(desconhecido)",
    to: headers.To ?? "",
    subject: headers.Subject ?? "(sem assunto)",
    date: headers.Date ?? "",
    body: extractBody(msg.payload ?? {}),
  };
}

function encodeHeaderText(text: string): string {
  // RFC 2047 — sempre codifica (mesmo texto puro ASCII decodifica
  // igual em qualquer cliente compatível), evita ter que detectar
  // "tem acento ou não" e lidar com os dois casos separadamente.
  return `=?UTF-8?B?${Buffer.from(text, "utf-8").toString("base64")}?=`;
}

interface BuildRawMessageInput {
  to: string;
  subject: string;
  bodyText: string;
  inReplyTo?: string;
  references?: string;
}

/**
 * Monta a mensagem RFC 2822 crua que a API do Gmail espera no campo
 * `raw` (base64url do e-mail inteiro, cabeçalhos + corpo). Corpo
 * sempre em base64 com `Content-Transfer-Encoding: base64` — evita
 * qualquer ambiguidade sobre bytes UTF-8 (acentos) trafegando "crus".
 */
function buildRawMessage(input: BuildRawMessageInput): string {
  const bodyBase64 = Buffer.from(input.bodyText, "utf-8").toString("base64");
  const headerLines = [`To: ${input.to}`, `Subject: ${encodeHeaderText(input.subject)}`];
  if (input.inReplyTo) headerLines.push(`In-Reply-To: ${input.inReplyTo}`);
  if (input.references) headerLines.push(`References: ${input.references}`);
  headerLines.push(`MIME-Version: 1.0`, `Content-Type: text/plain; charset="UTF-8"`, `Content-Transfer-Encoding: base64`);

  const raw = headerLines.join("\r\n") + "\r\n\r\n" + bodyBase64;
  return base64Url(Buffer.from(raw, "utf-8"));
}

export interface CreateDraftInput {
  to: string;
  subject: string;
  body: string;
}

export interface DraftResult {
  id: string;
  threadId?: string;
}

/** Rascunho novo, sem thread — nunca envia, só cria (POST /drafts). */
export async function createDraft(input: CreateDraftInput): Promise<DraftResult> {
  const raw = buildRawMessage({ to: input.to, subject: input.subject, bodyText: input.body });
  const draft = await gmailFetch(`/drafts`, {
    method: "POST",
    body: JSON.stringify({ message: { raw } }),
  });
  return { id: draft.id, threadId: draft.message?.threadId };
}

export interface ReplyDraftInput {
  messageId: string;
  body: string;
}

/**
 * Rascunho de RESPOSTA a um e-mail existente — mesma thread, mesmo
 * assunto (com "Re:" só se ainda não tiver), `In-Reply-To`/
 * `References` corretos apontando pro `Message-ID` (cabeçalho RFC, não
 * o `id` do Gmail) do e-mail original, pra aparecer encadeado de
 * verdade no cliente de e-mail, não como mensagem solta. Busca só os
 * headers necessários (`format=metadata`), não o corpo — não precisa
 * do conteúdo do e-mail original pra montar a resposta.
 */
export async function replyDraft(input: ReplyDraftInput): Promise<DraftResult> {
  const original = await gmailFetch(
    `/messages/${input.messageId}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Message-ID&metadataHeaders=References`
  );
  const headers = Object.fromEntries(
    ((original.payload?.headers ?? []) as Array<{ name: string; value: string }>).map((h) => [h.name, h.value])
  );

  const from = headers.From;
  if (!from) {
    throw new Error(`Não encontrei o remetente do e-mail ${input.messageId} — não dá pra montar a resposta.`);
  }
  const originalSubject = headers.Subject ?? "(sem assunto)";
  const subject = /^re:/i.test(originalSubject.trim()) ? originalSubject : `Re: ${originalSubject}`;
  const messageIdHeader = headers["Message-ID"];
  const references = [headers.References, messageIdHeader].filter(Boolean).join(" ") || undefined;

  const raw = buildRawMessage({
    to: from,
    subject,
    bodyText: input.body,
    inReplyTo: messageIdHeader,
    references,
  });

  const draft = await gmailFetch(`/drafts`, {
    method: "POST",
    body: JSON.stringify({ message: { raw, threadId: original.threadId } }),
  });
  return { id: draft.id, threadId: draft.message?.threadId ?? original.threadId };
}

// ---------------------------------------------------------------------
// Envio de rascunho JÁ EXISTENTE — a única ação irreversível de e-mail
// deste projeto, decisão deliberada (registrada em
// docs/architecture.md). NUNCA existe uma tool de "compor e enviar
// direto": o fluxo sempre passa por create_draft/reply_draft primeiro.
// Confirmado na documentação oficial da API antes de implementar (não
// assumido a partir da fase anterior): `users.drafts.send` aceita o
// escopo `gmail.compose` já autorizado — não precisou reautorizar.
// ---------------------------------------------------------------------

export interface DraftPreview {
  id: string;
  to: string;
  subject: string;
  /** Corpo truncado se for longo — é só um preview pra confirmação, não o conteúdo completo. */
  bodyPreview: string;
}

const DRAFT_PREVIEW_BODY_LIMIT = 500;

/**
 * Busca o conteúdo de um rascunho pra exibição legível ANTES de pedir
 * confirmação de envio (ver `formatConfirmationInput` em
 * packages/core/src/index.ts) — Para/Assunto/corpo, não o `draftId`
 * cru. Um rascunho, por baixo, é um `message` com a mesma estrutura de
 * payload MIME de um e-mail normal — reaproveita `extractBody`.
 */
export async function getDraftPreview(draftId: string): Promise<DraftPreview> {
  const draft = await gmailFetch(`/drafts/${draftId}?format=full`);
  const headers = Object.fromEntries(
    ((draft.message?.payload?.headers ?? []) as Array<{ name: string; value: string }>).map((h) => [h.name, h.value])
  );
  const body = extractBody(draft.message?.payload ?? {});
  const bodyPreview =
    body.length > DRAFT_PREVIEW_BODY_LIMIT ? body.slice(0, DRAFT_PREVIEW_BODY_LIMIT) + "…" : body;

  return {
    id: draftId,
    to: headers.To ?? "(sem destinatário)",
    subject: headers.Subject ?? "(sem assunto)",
    bodyPreview,
  };
}

export interface SendDraftResult {
  id: string;
  threadId?: string;
}

/** Envia um rascunho que já existe. NUNCA chamado a partir de nenhum outro lugar deste pacote a não ser a tool `send_draft`. */
export async function sendDraft(draftId: string): Promise<SendDraftResult> {
  const result = await gmailFetch(`/drafts/send`, {
    method: "POST",
    body: JSON.stringify({ id: draftId }),
  });
  return { id: result.id, threadId: result.threadId };
}
