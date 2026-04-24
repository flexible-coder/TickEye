export interface StockConfig {
  secid: string;
  code: string;
  name: string;
  enabled: boolean;
  defaultExpanded: boolean;
  position: {
    top: number;
    right: number;
  };
  tradingPollIntervalMs: number;
}

export const STOCK_CONFIG_STORAGE_KEY = "tickeye.stockConfig";

export const DEFAULT_STOCK_CONFIG: StockConfig = {
  secid: "1.600396",
  code: "600396",
  name: "金山股份",
  enabled: true,
  defaultExpanded: false,
  position: {
    top: 80,
    right: 20,
  },
  tradingPollIntervalMs: 3000,
};

const normalizeNumber = (value: unknown, fallback: number, min: number, max: number): number => {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
};

export const inferSecidFromCode = (code: string): string | null => {
  const normalizedCode = code.trim().replace(/\D/g, "");
  if (!/^\d{6}$/.test(normalizedCode)) return null;

  const marketPrefix = /^[569]/.test(normalizedCode) ? "1" : "0";
  return `${marketPrefix}.${normalizedCode}`;
};

export const parseStockInput = (input: string): Pick<StockConfig, "secid" | "code" | "name"> | null => {
  const trimmed = input.trim();
  const secidMatch = trimmed.match(/^([01])\.(\d{6})$/);

  if (secidMatch) {
    return {
      secid: `${secidMatch[1]}.${secidMatch[2]}`,
      code: secidMatch[2],
      name: secidMatch[2],
    };
  }

  const codeMatch = trimmed.match(/\d{6}/);
  if (!codeMatch) return null;

  const code = codeMatch[0];
  const secid = inferSecidFromCode(code);
  if (!secid) return null;

  return {
    secid,
    code,
    name: code,
  };
};

export const normalizeStockConfig = (value: Partial<StockConfig> | null | undefined): StockConfig => {
  const next = value ?? {};
  const parsedInput = next.secid ? parseStockInput(next.secid) : null;
  const code = typeof next.code === "string" && /^\d{6}$/.test(next.code) ? next.code : parsedInput?.code;
  const secid = typeof next.secid === "string" && /^[01]\.\d{6}$/.test(next.secid)
    ? next.secid
    : code
      ? inferSecidFromCode(code)
      : null;

  return {
    ...DEFAULT_STOCK_CONFIG,
    ...next,
    secid: secid ?? DEFAULT_STOCK_CONFIG.secid,
    code: code ?? DEFAULT_STOCK_CONFIG.code,
    name: typeof next.name === "string" && next.name.trim() ? next.name.trim() : code ?? DEFAULT_STOCK_CONFIG.name,
    enabled: typeof next.enabled === "boolean" ? next.enabled : DEFAULT_STOCK_CONFIG.enabled,
    defaultExpanded:
      typeof next.defaultExpanded === "boolean" ? next.defaultExpanded : DEFAULT_STOCK_CONFIG.defaultExpanded,
    position: {
      top: normalizeNumber(next.position?.top, DEFAULT_STOCK_CONFIG.position.top, 8, 600),
      right: normalizeNumber(next.position?.right, DEFAULT_STOCK_CONFIG.position.right, 8, 600),
    },
    tradingPollIntervalMs: normalizeNumber(
      next.tradingPollIntervalMs,
      DEFAULT_STOCK_CONFIG.tradingPollIntervalMs,
      1000,
      60000,
    ),
  };
};

const hasChromeStorage = () => typeof chrome !== "undefined" && !!chrome.storage?.sync;

export const getStockConfig = async (): Promise<StockConfig> => {
  if (!hasChromeStorage()) return DEFAULT_STOCK_CONFIG;

  const result = await chrome.storage.sync.get(STOCK_CONFIG_STORAGE_KEY);
  return normalizeStockConfig(result[STOCK_CONFIG_STORAGE_KEY] as Partial<StockConfig> | undefined);
};

export const saveStockConfig = async (config: Partial<StockConfig>): Promise<StockConfig> => {
  const normalizedConfig = normalizeStockConfig(config);

  if (hasChromeStorage()) {
    await chrome.storage.sync.set({
      [STOCK_CONFIG_STORAGE_KEY]: normalizedConfig,
    });
  }

  return normalizedConfig;
};
