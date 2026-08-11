/**
 * Chamadas cruas à API REST do Notion (sem SDK oficial como
 * dependência — só `fetch` global do Node, mesmo espírito leve dos
 * outros pacotes de tool).
 *
 * IMPORTANTE (pesquisado na documentação atual do Notion antes de
 * implementar, já que a API mudou recentemente): desde a versão
 * `2025-09-03`, um banco de dados do Notion pode ter várias "data
 * sources", e criar página exige `parent.data_source_id` — não dá
 * mais pra usar `parent.database_id` direto. Por isso o fluxo aqui é:
 * 1) resolver o `data_source_id` a partir do `database_id` que o
 *    usuário configurou (`GET /v1/databases/{id}` → `data_sources[0].id`),
 * 2) só então `POST /v1/pages` usando esse `data_source_id` como
 *    parent. Ver docs/architecture.md pra fontes e detalhes.
 */

const NOTION_API_VERSION = "2026-03-11";
const NOTION_API_BASE = "https://api.notion.com/v1";

function getEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(
      `Variável de ambiente ${name} não definida. Configure-a no .env (veja .env.example).`
    );
  }
  return value;
}

/**
 * `NOTION_CALENDAR_DATABASE_ID` costuma ser colado como a URL inteira
 * do banco (ex.: link de "Copiar link" do Notion), não o UUID puro —
 * aconteceu na validação real desta integração. Em vez de exigir que
 * o usuário extraia o ID à mão, procura os 32 caracteres hexadecimais
 * (com ou sem hífens já no formato UUID) em qualquer lugar da string.
 */
function extractDatabaseId(raw: string): string {
  const match = raw.match(/[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}/i);
  if (!match) {
    throw new Error(
      `Não consegui extrair um ID de banco de dados válido de NOTION_CALENDAR_DATABASE_ID (valor atual: "${raw}"). ` +
        "Use o UUID do banco ou cole a URL completa do banco de dados no Notion."
    );
  }
  return match[0];
}

async function notionFetch(path: string, init: RequestInit = {}): Promise<any> {
  const apiKey = getEnv("NOTION_API_KEY");
  const res = await fetch(`${NOTION_API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Notion-Version": NOTION_API_VERSION,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });

  const body = await res.json().catch(() => null);

  if (!res.ok) {
    throw buildNotionError(res.status, body);
  }
  return body;
}

function buildNotionError(status: number, body: { code?: string; message?: string } | null): Error {
  const message = body?.message ?? "erro desconhecido";

  if (status === 404 || body?.code === "object_not_found") {
    return new Error(
      "Notion não encontrou o banco de dados do Calendário (object_not_found). " +
        "Confirme que você compartilhou o banco de dados com a integração/token: " +
        "abra o banco no Notion → \"...\" no canto superior → Conexões → adicione a " +
        `sua integração. Mensagem original da API: ${message}`
    );
  }

  return new Error(`Notion API respondeu ${status}: ${message}`);
}

/**
 * Nome exato da propriedade Select de categoria no banco. Diferente
 * de título/data, um banco pode ter VÁRIAS propriedades do tipo
 * `select` (categoria, prioridade, status...) — não dá pra detectar
 * "a" propriedade select por tipo como se faz com título/data, que
 * são garantidamente únicas por data source. Por isso este nome é
 * fixo mesmo, casando com o nome real configurado no banco.
 */
const CATEGORY_PROPERTY_NAME = "Categoria";

interface CalendarSchema {
  dataSourceId: string;
  /**
   * Nomes reais das propriedades título/data no banco. NENHUM dos
   * dois é hardcoded ("Título"/"Data"): descoberto rodando de verdade
   * contra um banco real que usava "Name" (não "Título") e "Date"
   * (não "Data") — nomes de propriedade em bancos Notion são
   * arbitrários (e variam com o idioma da interface de quem criou o
   * banco). Detectar pelo TIPO da propriedade (`title` / `date`) em
   * vez de por nome evita essa classe inteira de erro de configuração.
   */
  titlePropertyName: string;
  datePropertyName: string;
  /**
   * `null` se o banco não tiver (ainda) uma propriedade
   * `CATEGORY_PROPERTY_NAME` do tipo `select` — categoria é opcional,
   * então isso só vira erro se alguém tentar criar um evento
   * passando `categoria` sem essa propriedade existir de verdade.
   */
  hasCategoryProperty: boolean;
}

/**
 * Busca o schema (data_source_id + propriedades) direto do Notion,
 * sem cache. Já teve cache em memória pra vida do processo aqui, mas
 * isso mordeu na prática: renomear/adicionar uma propriedade no
 * Notion enquanto um `pnpm dev` já estava rodando deixava o processo
 * preso no schema antigo até reiniciar — bug real encontrado
 * validando o parâmetro `categoria`. Uma chamada HTTP extra por
 * criação de evento é custo desprezível pra um assistente pessoal;
 * schema sempre atualizado vale mais que essa micro-otimização.
 */
async function resolveCalendarSchema(): Promise<CalendarSchema> {
  const databaseId = extractDatabaseId(getEnv("NOTION_CALENDAR_DATABASE_ID"));
  const db = await notionFetch(`/databases/${databaseId}`);
  const sources = (db.data_sources ?? []) as Array<{ id: string; name: string }>;
  if (sources.length === 0) {
    throw new Error(
      `O banco de dados ${databaseId} não tem nenhuma data source associada — verifique o ID configurado em NOTION_CALENDAR_DATABASE_ID.`
    );
  }
  const dataSourceId = sources[0].id;

  const dataSource = await notionFetch(`/data_sources/${dataSourceId}`);
  const properties = (dataSource.properties ?? {}) as Record<string, { type: string }>;

  const titleEntry = Object.entries(properties).find(([, def]) => def.type === "title");
  if (!titleEntry) {
    throw new Error("Não encontrei nenhuma propriedade do tipo Title no banco de dados do Calendário.");
  }

  const dateEntry = Object.entries(properties).find(([, def]) => def.type === "date");
  if (!dateEntry) {
    throw new Error(
      `O banco de dados não tem nenhuma propriedade do tipo Date. ` +
        `Propriedades encontradas: ${Object.keys(properties).join(", ") || "(nenhuma)"}. ` +
        "Crie uma propriedade do tipo Date no banco de dados no Notion e tente de novo."
    );
  }

  const categoryProperty = properties[CATEGORY_PROPERTY_NAME];
  const hasCategoryProperty = categoryProperty?.type === "select";

  return {
    dataSourceId,
    titlePropertyName: titleEntry[0],
    datePropertyName: dateEntry[0],
    hasCategoryProperty,
  };
}

export interface CreateCalendarEntryInput {
  title: string;
  date: string;
  endDate?: string;
  categoria?: string;
}

export interface CreateCalendarEntryResult {
  id: string;
  url: string;
}

/**
 * Cria uma entrada no banco de dados de Calendário do Notion.
 */
export async function createCalendarEntry(
  input: CreateCalendarEntryInput
): Promise<CreateCalendarEntryResult> {
  const { dataSourceId, titlePropertyName, datePropertyName, hasCategoryProperty } =
    await resolveCalendarSchema();

  if (input.categoria && !hasCategoryProperty) {
    throw new Error(
      `Categoria foi informada ("${input.categoria}") mas o banco de dados não tem uma propriedade ` +
        `"${CATEGORY_PROPERTY_NAME}" do tipo Select. Confirme o nome exato da propriedade no Notion.`
    );
  }

  const properties = {
    [titlePropertyName]: { title: [{ text: { content: input.title } }] },
    [datePropertyName]: {
      date: {
        start: input.date,
        ...(input.endDate ? { end: input.endDate } : {}),
      },
    },
    ...(input.categoria ? { [CATEGORY_PROPERTY_NAME]: { select: { name: input.categoria } } } : {}),
  };

  const page = await notionFetch("/pages", {
    method: "POST",
    body: JSON.stringify({
      parent: { type: "data_source_id", data_source_id: dataSourceId },
      properties,
    }),
  });

  return { id: page.id, url: page.url };
}
