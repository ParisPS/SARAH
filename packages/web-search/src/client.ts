/**
 * Chamada crua ao endpoint `/shopping` da Serper.dev (revenda de
 * resultados do Google Shopping, sem SDK oficial como dependência —
 * só `fetch` global do Node, mesmo espírito leve de
 * `packages/notion/src/client.ts`).
 *
 * Decisão de provedor (Fase 9, confirmada com o usuário ANTES de
 * implementar — não assumida): Bing Search API foi aposentada pela
 * Microsoft (agosto 2025); Google Custom Search JSON API está fechada
 * pra clientes NOVOS desde 2026 (confirmado na documentação oficial
 * do Google); Brave Search API exige cartão de crédito no cadastro
 * desde fevereiro de 2026, com cobrança automática sem teto de gasto.
 * Serper.dev foi a única opção encontrada com cota grátis (2.500
 * buscas) sem exigir cartão, MAIS um endpoint `/shopping` dedicado que
 * já devolve preço/loja/link estruturados — evita ter que extrair
 * preço de snippet de busca solto, que seria bem menos confiável.
 */

const SERPER_SHOPPING_URL = "https://google.serper.dev/shopping";

function getEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(
      `Variável de ambiente ${name} não definida. Configure-a no .env (veja .env.example).`
    );
  }
  return value;
}

interface SerperShoppingItem {
  title?: string;
  source?: string;
  price?: string;
  link?: string;
  rating?: number;
  ratingCount?: number;
  delivery?: string;
}

export interface PriceOption {
  title: string;
  price: string;
  source: string;
  link: string | null;
  rating: number | null;
}

export interface SearchPriceInput {
  item: string;
  maxResults?: number;
}

export interface SearchPriceResult {
  query: string;
  options: PriceOption[];
}

function buildSerperError(status: number, bodyText: string): Error {
  if (status === 401 || status === 403) {
    return new Error(
      `Serper.dev recusou a chave de API (${status}). Confirme SERPER_API_KEY no .env — gere uma nova em ` +
        "https://serper.dev se precisar."
    );
  }
  if (status === 429) {
    return new Error(
      "Serper.dev respondeu 429 (limite de requisições atingido) — a cota grátis (2.500 buscas) pode ter " +
        "acabado, ou muitas buscas em pouco tempo. Confirme o saldo em https://serper.dev."
    );
  }
  return new Error(`Serper.dev respondeu ${status}: ${bodyText.slice(0, 300)}`);
}

/**
 * Busca preços reais de um produto/serviço via Google Shopping (por
 * baixo da Serper.dev). Sempre busca em português/Brasil (`gl: "br"`,
 * `hl: "pt-br"`) — coerente com o resto do projeto (docs, moeda, uso
 * real do usuário). NUNCA inventa opção nenhuma: se a Serper devolver
 * a lista vazia (produto não encontrado/sem oferta), o resultado
 * também vem vazio — quem decide como comunicar isso ao usuário é a
 * tool (`index.ts`), não este cliente.
 */
export async function searchPrice(input: SearchPriceInput): Promise<SearchPriceResult> {
  const apiKey = getEnv("SERPER_API_KEY");
  const maxResults = input.maxResults ?? 5;

  const res = await fetch(SERPER_SHOPPING_URL, {
    method: "POST",
    headers: {
      "X-API-KEY": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ q: input.item, gl: "br", hl: "pt-br" }),
  });

  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    throw buildSerperError(res.status, bodyText);
  }

  const body = (await res.json().catch(() => null)) as { shopping?: SerperShoppingItem[] } | null;
  const items = Array.isArray(body?.shopping) ? body!.shopping! : [];

  const options: PriceOption[] = items
    .filter((item) => item.title && item.price)
    .slice(0, maxResults)
    .map((item) => ({
      title: item.title!,
      price: item.price!,
      source: item.source ?? "(loja não informada)",
      link: item.link ?? null,
      rating: typeof item.rating === "number" ? item.rating : null,
    }));

  return { query: input.item, options };
}
