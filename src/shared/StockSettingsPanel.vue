<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { message } from "ant-design-vue";
import {
  DEFAULT_STOCK_CONFIG,
  getStockConfig,
  normalizeStockConfig,
  parseStockInput,
  saveStockConfig,
  STOCK_CONFIG_STORAGE_KEY,
  type StockConfig,
} from "./stockConfig";
import { searchStocks, type StockSearchResult } from "./stockSearch";

type AutoCompleteOption = {
  value: string;
  label: string;
  stock: StockSearchResult;
};

const props = withDefaults(
  defineProps<{
    surface?: "popup" | "sidepanel";
  }>(),
  {
    surface: "popup",
  },
);

const config = ref<StockConfig>(DEFAULT_STOCK_CONFIG);
const searchText = ref("");
const searchOptions = ref<AutoCompleteOption[]>([]);
const optionByValue = ref<Record<string, StockSearchResult>>({});
const isLoading = ref(true);
const isSearching = ref(false);
const isSaving = ref(false);

let searchController: AbortController | null = null;
let searchSerial = 0;

const isSidepanel = computed(() => props.surface === "sidepanel");
const cardWidth = computed(() => (isSidepanel.value ? "min(100%, 560px)" : "390px"));
const currentStockText = computed(() => `${config.value.name} ${config.value.code} · ${config.value.secid}`);
const refreshSeconds = computed({
  get: () => String(Math.round(config.value.tradingPollIntervalMs / 1000)),
  set: (value: string) => {
    void updateConfig({
      tradingPollIntervalMs: Number(value) * 1000,
    });
  },
});

const formatOptionLabel = (stock: StockSearchResult) => {
  const market = stock.market ? ` · ${stock.market}` : "";
  return `${stock.name} ${stock.code}${market}`;
};

const setSearchResults = (results: StockSearchResult[]) => {
  const options = results.map((stock) => ({
    value: `${stock.name} ${stock.code}`,
    label: formatOptionLabel(stock),
    stock,
  }));

  searchOptions.value = options;
  optionByValue.value = Object.fromEntries(options.map((option) => [option.value, option.stock]));
};

const loadConfig = async () => {
  isLoading.value = true;
  try {
    config.value = await getStockConfig();
    searchText.value = `${config.value.name} ${config.value.code}`;
  } finally {
    isLoading.value = false;
  }
};

const updateConfig = async (patch: Partial<StockConfig>) => {
  isSaving.value = true;
  try {
    config.value = await saveStockConfig({
      ...config.value,
      ...patch,
    });
  } finally {
    isSaving.value = false;
  }
};

const applyStock = async (stock: Pick<StockConfig, "secid" | "code" | "name">) => {
  await updateConfig({
    secid: stock.secid,
    code: stock.code,
    name: stock.name,
  });
  searchText.value = `${stock.name} ${stock.code}`;
  void message.success(`已切换到 ${stock.name} (${stock.code})`);
};

const handleSearch = async (keyword: string) => {
  console.log('AAAAAAAAA');
  
  searchText.value = keyword;

  const trimmed = keyword.trim();
  if (!trimmed) {
    searchOptions.value = [];
    optionByValue.value = {};
    return;
  }

  searchController?.abort();
  searchController = new AbortController();
  const currentSerial = ++searchSerial;
  isSearching.value = true;

  try {
    const results = await searchStocks(trimmed, searchController.signal);
    if (currentSerial !== searchSerial) return;
    setSearchResults(results);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return;

    const parsedInput = parseStockInput(trimmed);
    if (parsedInput) {
      setSearchResults([
        {
          ...parsedInput,
          market: parsedInput.secid.startsWith("1.") ? "SH" : "SZ",
          type: "股票",
        },
      ]);
      return;
    }

    searchOptions.value = [];
    optionByValue.value = {};
    void message.warning("暂时没查到匹配股票，可以直接输入 6 位代码试试");
  } finally {
    if (currentSerial === searchSerial) {
      isSearching.value = false;
    }
  }
};

const handleSelect = (value: string) => {
  const stock = optionByValue.value[value];
  if (!stock) return;
  void applyStock(stock);
};

const applyCurrentInput = async (value: string, event: Event ) => {
  console.log('BBBBBBBBBBB',event);
  const keyword = (value ?? searchText.value).trim();
  if (!keyword) return;

  const selectedStock = optionByValue.value[keyword];
  if (selectedStock) {
    await applyStock(selectedStock);
    return;
  }

  const parsedInput = parseStockInput(keyword);
  if (parsedInput) {
    await applyStock(parsedInput);
    return;
  }

  const results = await searchStocks(keyword);
  if (results[0]) {
    await applyStock(results[0]);
    return;
  }

  void message.warning("没有找到对应股票，请换个名称或代码");
};

const resetPosition = () => {
  void updateConfig({
    position: DEFAULT_STOCK_CONFIG.position,
  });
};

const updateEnabled = (checked: boolean | string | number) => {
  void updateConfig({
    enabled: checked === true,
  });
};

const updateDefaultExpanded = (checked: boolean | string | number) => {
  void updateConfig({
    defaultExpanded: checked === true,
  });
};

const updatePositionTop = (value: number | string | null) => {
  void updateConfig({
    position: {
      ...config.value.position,
      top: Number(value) || DEFAULT_STOCK_CONFIG.position.top,
    },
  });
};

const updatePositionRight = (value: number | string | null) => {
  void updateConfig({
    position: {
      ...config.value.position,
      right: Number(value) || DEFAULT_STOCK_CONFIG.position.right,
    },
  });
};

const handleStorageChange = (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => {
  if (areaName !== "sync") return;

  const nextValue = changes[STOCK_CONFIG_STORAGE_KEY]?.newValue as Partial<StockConfig> | undefined;
  if (!nextValue) return;

  config.value = normalizeStockConfig(nextValue);
  searchText.value = `${config.value.name} ${config.value.code}`;
};

onMounted(() => {
  void loadConfig();
  if (typeof chrome !== "undefined") {
    chrome.storage?.onChanged?.addListener(handleStorageChange);
  }
});

onUnmounted(() => {
  searchController?.abort();
  if (typeof chrome !== "undefined") {
    chrome.storage?.onChanged?.removeListener(handleStorageChange);
  }
});
</script>

<template>
  <a-config-provider
    :theme="{
      token: {
        colorPrimary: '#0f766e',
        borderRadius: 14,
        fontFamily: 'Sora, ui-sans-serif, system-ui',
      },
    }"
  >
    <main class="settings-page" :class="{ 'is-sidepanel': isSidepanel }">
      <section class="settings-card" :style="{ width: cardWidth }">
        <div class="hero">
          <div>
            <p class="eyebrow">TickEye Config</p>
            <h1>股票盯盘助手</h1>
            <p class="subtitle">输入股票代码或名称，页面悬浮窗会立刻切换到对应分时行情。</p>
          </div>
          <div class="orb" aria-hidden="true"></div>
        </div>

        <a-skeleton v-if="isLoading" active :paragraph="{ rows: 5 }" />

        <template v-else>
          <a-card class="glass-card" :bordered="false">
            <template #title>当前股票</template>
            <template #extra>
              <a-tag color="green">{{ config.enabled ? "已显示" : "已隐藏" }}</a-tag>
            </template>

            <div class="current-stock">
              <span>{{ currentStockText }}</span>
            </div>

            <a-auto-complete
              v-model:value="searchText"
              class="stock-search"
              :options="searchOptions"
              :filter-option="false"
              @search="handleSearch"
            >
              <a-input-search
                size="large"
                placeholder="搜索股票名称 / 代码，如 贵州茅台 或 600519"
                enter-button="应用"
                :loading="isSearching || isSaving"
                @search="applyCurrentInput"
              />
            </a-auto-complete>

            <p class="hint">数据源：东方财富搜索接口 + 分时接口；代码会保存为 secid，例如 1.600519。</p>
          </a-card>

          <a-card class="glass-card" :bordered="false" title="悬浮窗设置">
            <div class="setting-row">
              <div>
                <strong>显示悬浮窗</strong>
                <span>临时关掉行情卡片，但保留配置。</span>
              </div>
              <a-switch :checked="config.enabled" :loading="isSaving" @change="updateEnabled" />
            </div>

            <a-divider />

            <div class="setting-row">
              <div>
                <strong>默认展开图表</strong>
                <span>刷新页面后直接展示分时图。</span>
              </div>
              <a-switch :checked="config.defaultExpanded" :loading="isSaving" @change="updateDefaultExpanded" />
            </div>

            <a-divider />

            <div class="position-grid">
              <label>
                距顶部
                <a-input-number
                  :value="config.position.top"
                  :min="8"
                  addon-after="px"
                  @change="updatePositionTop"
                />
              </label>
              <label>
                距右侧
                <a-input-number
                  :value="config.position.right"
                  :min="8"
                  addon-after="px"
                  @change="updatePositionRight"
                />
              </label>
              <a-button class="reset-button" @click="resetPosition">重置位置</a-button>
            </div>
          </a-card>

          <a-card class="glass-card" :bordered="false" title="刷新频率">
            <a-radio-group v-model:value="refreshSeconds" option-type="button" button-style="solid">
              <a-radio-button value="3">3 秒</a-radio-button>
              <a-radio-button value="5">5 秒</a-radio-button>
              <a-radio-button value="10">10 秒</a-radio-button>
              <a-radio-button value="30">30 秒</a-radio-button>
            </a-radio-group>
            <p class="hint">仅影响交易时段；非交易时段仍会自动降频，避免没必要的请求。</p>
          </a-card>
        </template>
      </section>
    </main>
  </a-config-provider>
</template>

<style scoped>
.settings-page {
  min-height: 100vh;
  padding: 18px;
  display: flex;
  justify-content: center;
  background:
    radial-gradient(circle at 14% 12%, rgba(20, 184, 166, 0.3), transparent 28%),
    radial-gradient(circle at 85% 0%, rgba(245, 158, 11, 0.24), transparent 28%),
    linear-gradient(135deg, #f7fee7 0%, #ecfeff 46%, #fff7ed 100%);
  color: #12312f;
}

.settings-page.is-sidepanel {
  align-items: flex-start;
  padding: 28px 18px;
}

.settings-card {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.hero {
  position: relative;
  overflow: hidden;
  min-height: 126px;
  padding: 22px;
  border: 1px solid rgba(15, 118, 110, 0.16);
  border-radius: 28px;
  background:
    linear-gradient(135deg, rgba(15, 118, 110, 0.9), rgba(20, 83, 45, 0.9)),
    repeating-linear-gradient(45deg, rgba(255, 255, 255, 0.12) 0 1px, transparent 1px 11px);
  color: #f8fffb;
  box-shadow: 0 22px 60px rgba(15, 118, 110, 0.2);
}

.eyebrow {
  margin: 0 0 8px;
  font-size: 12px;
  font-weight: 800;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: rgba(255, 255, 255, 0.7);
}

h1 {
  margin: 0;
  font-size: 30px;
  line-height: 1.08;
  letter-spacing: -0.05em;
}

.subtitle {
  max-width: 270px;
  margin: 12px 0 0;
  color: rgba(255, 255, 255, 0.78);
  font-size: 13px;
}

.orb {
  position: absolute;
  right: -34px;
  bottom: -36px;
  width: 126px;
  height: 126px;
  border-radius: 999px;
  background: radial-gradient(circle at 32% 28%, #fef3c7, transparent 28%), linear-gradient(135deg, #f97316, #facc15);
  box-shadow: inset 0 0 24px rgba(255, 255, 255, 0.36);
}

.glass-card {
  border-radius: 24px;
  background: rgba(255, 255, 255, 0.76);
  box-shadow: 0 16px 48px rgba(17, 94, 89, 0.12);
  backdrop-filter: blur(18px);
}

.current-stock {
  display: inline-flex;
  width: 100%;
  margin-bottom: 12px;
  padding: 12px 14px;
  border-radius: 16px;
  background: rgba(15, 118, 110, 0.08);
  color: #0f766e;
  font-weight: 800;
}

.stock-search {
  width: 100%;
}

.hint {
  margin: 10px 0 0;
  color: #64748b;
  font-size: 12px;
}

.setting-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.setting-row strong,
.position-grid label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  color: #12312f;
  font-size: 14px;
}

.setting-row span {
  color: #64748b;
  font-size: 12px;
  font-weight: 400;
}

.position-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  align-items: end;
}

.reset-button {
  grid-column: 1 / -1;
}

@media (max-width: 430px) {
  .settings-page {
    padding: 12px;
  }

  .settings-card {
    width: 100% !important;
  }

  h1 {
    font-size: 26px;
  }
}
</style>
