import { inferSecidFromCode, parseStockInput } from "./stockConfig";

export interface StockSearchResult {
  secid: string;
  code: string;
  name: string;
  market: string;
  type: string;
}

type EastMoneySuggestItem = {
  Code?: string;
  code?: string;
  Name?: string;
  name?: string;
  QuoteID?: string;
  quoteId?: string;
  SecurityTypeName?: string;
  securityTypeName?: string;
  JYS?: string;
  jys?: string;
  MarketType?: string;
  marketType?: string;
};

const SEARCH_API_URL = "https://searchapi.eastmoney.com/api/suggest/get";

const getSuggestRows = (payload: unknown): EastMoneySuggestItem[] => {
  if (!payload || typeof payload !== "object") return [];

  const root = payload as Record<string, unknown>;
  const table = root.QuotationCodeTable ?? root.quotationCodeTable;
  if (table && typeof table === "object") {
    const data = (table as Record<string, unknown>).Data ?? (table as Record<string, unknown>).data;
    return Array.isArray(data) ? (data as EastMoneySuggestItem[]) : [];
  }

  const data = root.Data ?? root.data;
  return Array.isArray(data) ? (data as EastMoneySuggestItem[]) : [];
};

const normalizeSuggestItem = (item: EastMoneySuggestItem): StockSearchResult | null => {
  const code = String(item.Code ?? item.code ?? "").trim();
  if (!/^\d{6}$/.test(code)) return null;

  const secid = String(item.QuoteID ?? item.quoteId ?? inferSecidFromCode(code) ?? "").trim();
  if (!/^[01]\.\d{6}$/.test(secid)) return null;

  const name = String(item.Name ?? item.name ?? code).trim();
  const market = String(item.JYS ?? item.jys ?? item.MarketType ?? item.marketType ?? "").trim();
  const type = String(item.SecurityTypeName ?? item.securityTypeName ?? "股票").trim();

  return {
    secid,
    code,
    name,
    market,
    type,
  };
};

export const searchStocks = async (keyword: string, signal?: AbortSignal): Promise<StockSearchResult[]> => {
  const trimmed = keyword.trim();
  if (!trimmed) return [];

  const query = new URLSearchParams({
    input: trimmed,
    type: "14",
    token: "D43BF722C8E33BDC906FB84D85E326E8",
    count: "8",
  });

  const response = await fetch(`${SEARCH_API_URL}?${query.toString()}`, {
    headers: { "Cache-Control": "no-cache" },
    signal,
  });
  const payload: unknown = await response.json();
  const results = getSuggestRows(payload).map(normalizeSuggestItem).filter((item): item is StockSearchResult => !!item);

  if (results.length > 0) return results;

  const parsedInput = parseStockInput(trimmed);
  if (!parsedInput) return [];

  return [
    {
      ...parsedInput,
      market: parsedInput.secid.startsWith("1.") ? "SH" : "SZ",
      type: "股票",
    },
  ];
};
