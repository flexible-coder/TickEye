<template>
  <div class="stock-widget-container">
    <div class="stock-card" :class="{ 'is-expanded': isExpanded }" @click="isExpanded = !isExpanded">
      <div class="minimal-content">
        <span class="stock-name">{{ stockData.name }}</span>
        <span class="stock-percent" :class="[trendClass, { 'price-flash': shouldFlash }]">
          {{ stockData.percent > 0 ? "+" : "" }}{{ stockData.percent.toFixed(2) }}%
        </span>
      </div>

      <div class="expanded-wrapper">
        <div class="detail-section">
          <div class="chart-info-header">
            <span class="info-time">{{ displayTime || "--:--" }}</span>
            <span class="info-price" :class="displayTrendClass">
              {{ displayPrice.toFixed(2) }}
              <span class="info-percent">{{ displayPercentText }}</span>
            </span>
          </div>
        </div>

        <div ref="chartContainerRef" class="chart-container"></div>

        <div ref="tooltipRef" class="floating-tooltip" :class="{ visible: !!hoverInfo }">
          <div class="tooltip-time">
            <span>时间：</span>
            {{ hoverInfo?.time }}
          </div>
          <div class="tooltip-price" :class="hoverInfo && hoverInfo.percent >= 0 ? 'up' : 'down'">
            <span class="tooltip-label">价格：</span>
            <span> {{ hoverInfo?.price.toFixed(2) }}</span>
          </div>
          <div class="tooltip-price avg">
            <span class="tooltip-label">均价：</span>
            <span>{{ hoverInfo?.avgPrice.toFixed(2) }}</span>
          </div>
          <div class="tooltip-price" :class="hoverInfo && hoverInfo.percent >= 0 ? 'up' : 'down'">
            <span class="tooltip-label">涨跌幅：</span>
            <span>{{ hoverPercentText }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import {
  AreaSeries,
  ColorType,
  createChart,
  CrosshairMode,
  LineSeries,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import { sampleChartDataByWidth, type ChartPoint } from "../utils/chartSampling";

interface Stock {
  name: string;
  price: number;
  percent: number;
}

interface HoverInfo {
  time: string;
  price: number;
  avgPrice: number;
  percent: number;
  x: number;
  y: number;
}

interface IntradayPoint extends ChartPoint {
  avgPrice: number;
}

const STOCK_CODE = "0.002361";
const MARKET_TIME_ZONE = "Asia/Shanghai";
const MARKET_UTC_OFFSET_HOURS = 8;
const TRADING_POLL_INTERVAL_MS = 1000 * 3;
const OFF_HOURS_POLL_INTERVAL_MS = 1000 * 60 * 2;
const HIDDEN_POLL_INTERVAL_MS = 1000 * 60 * 3;

type SeriesPoint = { time: UTCTimestamp; value: number };

const SH_TIME_FORMATTER = new Intl.DateTimeFormat("zh-CN", {
  timeZone: MARKET_TIME_ZONE,
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

const isExpanded = ref(false);
const shouldFlash = ref(false);
const chartContainerRef = ref<HTMLDivElement | null>(null);
const tooltipRef = ref<HTMLDivElement | null>(null);
const chartWidth = ref(0);
const rawData = ref<IntradayPoint[]>([]);
const hoverInfo = ref<HoverInfo | null>(null);
const preClosePrice = ref(0);
const isFetching = ref(false);

const stockData = ref<Stock>({
  name: "加载中...",
  price: 0,
  percent: 0,
});

let chart: IChartApi | null = null;
let areaSeries: ISeriesApi<"Area"> | null = null;
let avgLineSeries: ISeriesApi<"Line"> | null = null;
let resizeObserver: ResizeObserver | null = null;
let pollingTimer: ReturnType<typeof setTimeout> | null = null;
let fetchController: AbortController | null = null;
let isMounted = false;
let appliedSeriesData: SeriesPoint[] = [];
let appliedAvgSeriesData: SeriesPoint[] = [];
let lastAppliedTrendColor = "";

const trendClass = computed(() => (stockData.value.percent >= 0 ? "up" : "down"));
const trendColor = computed(() => (stockData.value.percent >= 0 ? "#f23645" : "#089981"));

const latestTime = computed(() => {
  const lastPoint = rawData.value[rawData.value.length - 1];
  return lastPoint ? formatMarketTimeFromTimestamp(lastPoint.time) : "";
});

const displayTime = computed(() => hoverInfo.value?.time ?? latestTime.value);
const displayPrice = computed(() => hoverInfo.value?.price ?? stockData.value.price);
const displayPercent = computed(() => hoverInfo.value?.percent ?? stockData.value.percent);
const displayTrendClass = computed(() => (displayPercent.value >= 0 ? "up" : "down"));
const displayPercentText = computed(() => `${displayPercent.value > 0 ? "+" : ""}${displayPercent.value.toFixed(2)}%`);
const hoverPercentText = computed(() => {
  if (!hoverInfo.value) return "";
  return `${hoverInfo.value.percent > 0 ? "+" : ""}${hoverInfo.value.percent.toFixed(2)}%`;
});

const sampledData = computed<IntradayPoint[]>(() => sampleChartDataByWidth(rawData.value, chartWidth.value));
const sampledSeriesData = computed<SeriesPoint[]>(() =>
  sampledData.value.map((point) => ({
    time: point.time as UTCTimestamp,
    value: point.value,
  })),
);
const sampledAvgSeriesData = computed<SeriesPoint[]>(() =>
  sampledData.value.map((point) => ({
    time: point.time as UTCTimestamp,
    value: point.avgPrice,
  })),
);
const pointIndex = computed(() => new Map(rawData.value.map((point) => [point.time, point])));

const formatPriceAsPercent = (price: number): string => {
  if (preClosePrice.value <= 0) {
    return `${price.toFixed(2)}`;
  }
  const percent = ((price - preClosePrice.value) / preClosePrice.value) * 100;
  return `${percent > 0 ? "+" : ""}${percent.toFixed(2)}%`;
};

const getTimestampFromTime = (time: Time | undefined): number | null => {
  if (!time) return null;
  if (typeof time === "number") return time;
  if (typeof time === "object" && "timestamp" in time && typeof time.timestamp === "number") return time.timestamp;
  return null;
};

const formatMarketTimeFromTimestamp = (timestamp: number): string => {
  return SH_TIME_FORMATTER.format(new Date(timestamp * 1000));
};

const parseEastMoneyDateTimeToTimestamp = (dateTimeText: string): number | null => {
  const fullDateTimeMatch = dateTimeText.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})$/);
  if (fullDateTimeMatch) {
    const year = Number(fullDateTimeMatch[1]);
    const month = Number(fullDateTimeMatch[2]);
    const day = Number(fullDateTimeMatch[3]);
    const hours = Number(fullDateTimeMatch[4]);
    const minutes = Number(fullDateTimeMatch[5]);
    return Math.floor(Date.UTC(year, month - 1, day, hours - MARKET_UTC_OFFSET_HOURS, minutes) / 1000);
  }

  const timeOnlyMatch = dateTimeText.match(/^(\d{2}):(\d{2})$/);
  if (timeOnlyMatch) {
    const now = new Date();
    const year = now.getUTCFullYear();
    const month = now.getUTCMonth();
    const day = now.getUTCDate();
    const hours = Number(timeOnlyMatch[1]);
    const minutes = Number(timeOnlyMatch[2]);
    return Math.floor(Date.UTC(year, month, day, hours - MARKET_UTC_OFFSET_HOURS, minutes) / 1000);
  }

  return null;
};

const formatMarketTimeFromChartTime = (time: Time | undefined): string => {
  const timestamp = getTimestampFromTime(time);
  if (typeof timestamp !== "number") return "";
  return formatMarketTimeFromTimestamp(timestamp);
};

const parseFiniteNumber = (value: string | undefined): number | null => {
  if (!value) return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const getTrendPrice = (fields: string[]): number | null => {
  return parseFiniteNumber(fields[2]) ?? parseFiniteNumber(fields[1]);
};

const getTrendAveragePrice = (fields: string[], price: number): number => {
  const apiAveragePrice = parseFiniteNumber(fields[7]);
  if (apiAveragePrice && apiAveragePrice > 0) return apiAveragePrice;

  const volume = parseFiniteNumber(fields[5]);
  const amount = parseFiniteNumber(fields[6]);
  if (volume && amount && volume > 0) {
    const isReasonableAverage = (value: number) => value > price * 0.2 && value < price * 5;
    const directAverage = amount / volume;
    if (Number.isFinite(directAverage) && directAverage > 0 && isReasonableAverage(directAverage)) return directAverage;

    const handAverage = amount / (volume * 100);
    if (Number.isFinite(handAverage) && handAverage > 0 && isReasonableAverage(handAverage)) return handAverage;
  }

  return price;
};

const getShanghaiNow = (): Date => {
  return new Date(new Date().toLocaleString("en-US", { timeZone: MARKET_TIME_ZONE }));
};

const isTradingSessionNow = (): boolean => {
  const now = getShanghaiNow();
  const day = now.getDay();
  if (day === 0 || day === 6) return false;

  const minutes = now.getHours() * 60 + now.getMinutes();
  const inMorning = minutes >= 9 * 60 + 30 && minutes <= 11 * 60 + 30;
  const inAfternoon = minutes >= 13 * 60 && minutes <= 15 * 60;
  return inMorning || inAfternoon;
};

const getNextPollInterval = (): number => {
  if (document.hidden) return HIDDEN_POLL_INTERVAL_MS;
  return isTradingSessionNow() ? TRADING_POLL_INTERVAL_MS : OFF_HOURS_POLL_INTERVAL_MS;
};

const clearPollingTimer = () => {
  if (pollingTimer) {
    clearTimeout(pollingTimer);
    pollingTimer = null;
  }
};

const scheduleNextPoll = () => {
  if (!isMounted) return;

  clearPollingTimer();
  pollingTimer = setTimeout(() => {
    void runPollingCycle();
  }, getNextPollInterval());
};

const runPollingCycle = async () => {
  if (!isMounted) return;

  await fetchIntradayData();
  scheduleNextPoll();
};

const refreshPollingSchedule = () => {
  if (!isMounted) return;

  clearPollingTimer();
  if (document.hidden) {
    scheduleNextPoll();
    return;
  }

  void runPollingCycle();
};

const abortFetch = () => {
  if (fetchController) {
    fetchController.abort();
    fetchController = null;
  }
};

const sameSeriesPoint = (a: SeriesPoint, b: SeriesPoint): boolean => a.time === b.time && a.value === b.value;

const isSameRawData = (next: ChartPoint[]): boolean => {
  const prev = rawData.value;
  if (prev.length !== next.length) return false;
  if (prev.length === 0) return true;

  const lastPrev = prev[prev.length - 1];
  const lastNext = next[next.length - 1];
  if (lastPrev.time !== lastNext.time || lastPrev.value !== lastNext.value) return false;

  const firstPrev = prev[0];
  const firstNext = next[0];
  return firstPrev.time === firstNext.time && firstPrev.value === firstNext.value;
};

const applySeriesData = (nextData: SeriesPoint[], forceSetData = false) => {
  if (!areaSeries) return;
  const prevData = appliedSeriesData;

  if (forceSetData || prevData.length === 0) {
    areaSeries.setData(nextData);
    appliedSeriesData = nextData.slice();
    return;
  }

  if (nextData.length === prevData.length) {
    let sameTimeStructure = true;
    for (let i = 0; i < nextData.length; i += 1) {
      if (nextData[i].time !== prevData[i].time) {
        sameTimeStructure = false;
        break;
      }
    }

    if (!sameTimeStructure) {
      areaSeries.setData(nextData);
      appliedSeriesData = nextData.slice();
      return;
    }

    if (nextData.length > 0 && !sameSeriesPoint(nextData[nextData.length - 1], prevData[prevData.length - 1])) {
      areaSeries.update(nextData[nextData.length - 1]);
      appliedSeriesData = nextData.slice();
    }
    return;
  }

  if (nextData.length === prevData.length + 1) {
    let samePrefix = true;
    for (let i = 0; i < prevData.length; i += 1) {
      if (!sameSeriesPoint(nextData[i], prevData[i])) {
        samePrefix = false;
        break;
      }
    }

    if (samePrefix) {
      areaSeries.update(nextData[nextData.length - 1]);
      appliedSeriesData = nextData.slice();
      return;
    }
  }

  areaSeries.setData(nextData);
  appliedSeriesData = nextData.slice();
};

const applyAvgSeriesData = (nextData: SeriesPoint[], forceSetData = false) => {
  if (!avgLineSeries) return;
  const prevData = appliedAvgSeriesData;

  if (forceSetData || prevData.length === 0) {
    avgLineSeries.setData(nextData);
    appliedAvgSeriesData = nextData.slice();
    return;
  }

  if (nextData.length === prevData.length) {
    let sameTimeStructure = true;
    for (let i = 0; i < nextData.length; i += 1) {
      if (nextData[i].time !== prevData[i].time) {
        sameTimeStructure = false;
        break;
      }
    }

    if (!sameTimeStructure) {
      avgLineSeries.setData(nextData);
      appliedAvgSeriesData = nextData.slice();
      return;
    }

    if (nextData.length > 0 && !sameSeriesPoint(nextData[nextData.length - 1], prevData[prevData.length - 1])) {
      avgLineSeries.update(nextData[nextData.length - 1]);
      appliedAvgSeriesData = nextData.slice();
    }
    return;
  }

  if (nextData.length === prevData.length + 1) {
    let samePrefix = true;
    for (let i = 0; i < prevData.length; i += 1) {
      if (!sameSeriesPoint(nextData[i], prevData[i])) {
        samePrefix = false;
        break;
      }
    }

    if (samePrefix) {
      avgLineSeries.update(nextData[nextData.length - 1]);
      appliedAvgSeriesData = nextData.slice();
      return;
    }
  }

  avgLineSeries.setData(nextData);
  appliedAvgSeriesData = nextData.slice();
};

watch(
  () => stockData.value.price,
  () => {
    shouldFlash.value = false;
    requestAnimationFrame(() => {
      shouldFlash.value = true;
    });
  },
);

const applyTooltipPosition = (x: number, y: number) => {
  if (!tooltipRef.value || !chartContainerRef.value) return;

  const tooltip = tooltipRef.value;
  const containerRect = chartContainerRef.value.getBoundingClientRect();

  const margin = 8;
  let left = x + margin;
  let top = y + margin;

  const estimatedWidth = tooltip.offsetWidth || 110;
  const estimatedHeight = tooltip.offsetHeight || 52;

  if (left + estimatedWidth > containerRect.width) {
    left = x - estimatedWidth - margin;
  }

  if (top + estimatedHeight > containerRect.height) {
    top = y - estimatedHeight - margin;
  }

  tooltip.style.left = `${Math.max(0, left)}px`;
  tooltip.style.top = `${Math.max(0, top)}px`;
};

const hideHover = () => {
  hoverInfo.value = null;
};

const initChart = () => {
  if (!isMounted || !isExpanded.value) return;
  if (!chartContainerRef.value) return;

  if (chart && areaSeries) return;

  const width = chartContainerRef.value.clientWidth;
  const height = chartContainerRef.value.clientHeight;
  if (width < 100) return;
  chartWidth.value = Math.floor(width);

  chart = createChart(chartContainerRef.value, {
    width,
    height: height || 120,
    layout: {
      background: { type: ColorType.Solid, color: "transparent" },
      textColor: "#999",
      fontSize: 10,
      attributionLogo: false,
    },
    localization: {
      locale: "zh-CN",
      timeFormatter: (time: Time) => formatMarketTimeFromChartTime(time),
    },
    grid: {
      vertLines: { visible: false },
      horzLines: { visible: true, color: "rgba(0,0,0,0.05)", style: LineStyle.Dotted },
    },
    crosshair: {
      mode: CrosshairMode.Normal,
      vertLine: {
        color: "#758696",
        width: 1,
        style: LineStyle.Dashed,
        labelBackgroundColor: "#758696",
      },
      horzLine: {
        color: "#758696",
        width: 1,
        style: LineStyle.Dashed,
        labelBackgroundColor: "#758696",
      },
    },
    rightPriceScale: {
      visible: true,
      borderVisible: false,
      ensureEdgeTickMarksVisible: true,
      entireTextOnly: false,
      scaleMargins: {
        top: 0.02,
        bottom: 0.02,
      },
    },
    timeScale: {
      visible: true,
      borderVisible: false,
      timeVisible: true,
      secondsVisible: false,
      fixLeftEdge: true,
      fixRightEdge: true,
      tickMarkFormatter: (time: Time) => formatMarketTimeFromChartTime(time),
    },
    handleScroll: { vertTouchDrag: false },
    handleScale: false,
  });

  if (resizeObserver) resizeObserver.disconnect();
  resizeObserver = new ResizeObserver((entries) => {
    if (!chart) return;
    for (const entry of entries) {
      const { width: nextWidth, height: nextHeight } = entry.contentRect;
      if (nextWidth > 0) {
        chartWidth.value = Math.floor(nextWidth);
        chart.applyOptions({ width: nextWidth, height: nextHeight || 120 });
        chart.timeScale().fitContent();
      }
    }
  });
  resizeObserver.observe(chartContainerRef.value);

  areaSeries = chart.addSeries(AreaSeries, {
    lineColor: trendColor.value,
    topColor: `${trendColor.value}4D`,
    bottomColor: `${trendColor.value}00`,
    lineWidth: 1,
    priceFormat: {
      type: "custom",
      minMove: 0.01,
      formatter: formatPriceAsPercent,
    },
    priceLineVisible: false,
    lastValueVisible: false,
    crosshairMarkerVisible: true,
    crosshairMarkerRadius: 4,
    crosshairMarkerBorderColor: "#fff",
    crosshairMarkerBorderWidth: 2,
  });
  avgLineSeries = chart.addSeries(LineSeries, {
    color: "#f5a623",
    lineWidth: 1,
    priceLineVisible: false,
    lastValueVisible: false,
    crosshairMarkerVisible: false,
  });
  lastAppliedTrendColor = trendColor.value;

  chart.subscribeCrosshairMove((param) => {
    if (!areaSeries || !param.point || !param.time) {
      hideHover();
      return;
    }

    const priceData = param.seriesData.get(areaSeries) as { value?: number } | undefined;
    if (!priceData || typeof priceData.value !== "number") {
      hideHover();
      return;
    }

    const timestamp = getTimestampFromTime(param.time);
    if (typeof timestamp !== "number") {
      hideHover();
      return;
    }

    const point = pointIndex.value.get(timestamp);
    if (!point || preClosePrice.value <= 0) {
      hideHover();
      return;
    }

    hoverInfo.value = {
      time: formatMarketTimeFromTimestamp(point.time),
      price: point.value,
      avgPrice: point.avgPrice,
      percent: ((point.value - preClosePrice.value) / preClosePrice.value) * 100,
      x: param.point.x,
      y: param.point.y,
    };

    requestAnimationFrame(() => {
      if (hoverInfo.value) {
        applyTooltipPosition(hoverInfo.value.x, hoverInfo.value.y);
      }
    });
  });

  chartContainerRef.value.addEventListener("mouseleave", hideHover);
  applySeriesData(sampledSeriesData.value, true);
  applyAvgSeriesData(sampledAvgSeriesData.value, true);
  chart.timeScale().fitContent();
};

const fetchIntradayData = async () => {
  if (isFetching.value) return;
  isFetching.value = true;
  fetchController = new AbortController();

  try {
    const response = await fetch(
      `https://push2.eastmoney.com/api/qt/stock/trends2/get?secid=${STOCK_CODE}&fields1=f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13&fields2=f51,f52,f53,f54,f55,f56,f57,f58&ut=fa5fd1943c7b386f172d6893dbfba10b&ndays=1&iscr=0&iscca=0`,
      {
        headers: { "Cache-Control": "no-cache" },
        signal: fetchController.signal,
      },
    );

    const result = await response.json();
    if (!result.data?.trends) return;

    const trends = result.data.trends as string[];
    const preClose = Number(result.data.preClose) || 0;
    preClosePrice.value = preClose;

    const parsedData: IntradayPoint[] = [];
    let currentPrice = 0;

    for (const item of trends) {
      const fields = item.split(",");
      const timeStr = fields[0];
      const price = getTrendPrice(fields) ?? 0;
      const avgPrice = getTrendAveragePrice(fields, price);

      if (price <= 0 || avgPrice <= 0) continue;

      const timestamp = parseEastMoneyDateTimeToTimestamp(timeStr);
      if (typeof timestamp !== "number") continue;

      parsedData.push({ time: timestamp, value: price, avgPrice });
      currentPrice = price;
    }

    if (!isSameRawData(parsedData)) {
      rawData.value = parsedData;
    }

    if (result.data.name) {
      stockData.value.name = result.data.name;
    }

    if (currentPrice > 0 && preClose > 0) {
      stockData.value.price = currentPrice;
      stockData.value.percent = ((currentPrice - preClose) / preClose) * 100;
    }

    if (!areaSeries) return;
    const nextTrendColor = trendColor.value;
    if (nextTrendColor !== lastAppliedTrendColor) {
      areaSeries.applyOptions({
        lineColor: nextTrendColor,
        topColor: `${nextTrendColor}4D`,
        bottomColor: `${nextTrendColor}00`,
      });
      lastAppliedTrendColor = nextTrendColor;
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return;
    console.error("获取分时数据失败:", error);
  } finally {
    fetchController = null;
    isFetching.value = false;
  }
};

onMounted(async () => {
  await nextTick();
  isMounted = true;
  document.addEventListener("visibilitychange", refreshPollingSchedule);
  void runPollingCycle();
});

watch(isExpanded, async (expanded) => {
  if (!expanded) return;

  await nextTick();
  requestAnimationFrame(initChart);
});

watch(sampledSeriesData, (nextData) => {
  applySeriesData(nextData);
});

watch(sampledAvgSeriesData, (nextData) => {
  applyAvgSeriesData(nextData);
});

onUnmounted(() => {
  isMounted = false;
  document.removeEventListener("visibilitychange", refreshPollingSchedule);

  if (chartContainerRef.value) {
    chartContainerRef.value.removeEventListener("mouseleave", hideHover);
  }

  if (resizeObserver) {
    resizeObserver.disconnect();
    resizeObserver = null;
  }

  clearPollingTimer();
  abortFetch();

  if (chart) {
    chart.remove();
    chart = null;
  }

  areaSeries = null;
  avgLineSeries = null;
  appliedSeriesData = [];
  appliedAvgSeriesData = [];
  lastAppliedTrendColor = "";
});
</script>

<style scoped>
@keyframes priceBeat {
  0% {
    transform: scale(1);
    opacity: 1;
  }
  20% {
    transform: scale(1.1);
    opacity: 0.8;
  }
  40% {
    transform: scale(1);
    opacity: 1;
  }
  100% {
    transform: scale(1);
    opacity: 1;
  }
}

.price-flash {
  animation: priceBeat 0.4s linear;
  display: inline-block;
  will-change: transform, opacity;
}

.stock-widget-container {
  position: fixed;
  right: 20px;
  top: 80px;
  z-index: 9999;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  color: #333;
  user-select: none;
}

.stock-card {
  width: 140px;
  height: 40px;
  background: transparent;
  border-radius: 12px;
  cursor: pointer;
  overflow: hidden;
  transition: all 0.4s cubic-bezier(0.25, 0.8, 0.25, 1);
  display: flex;
  flex-direction: column;
}

.stock-card.is-expanded {
  height: 300px;
  width: 400px;
  background: rgba(255, 255, 255, 0.7);
}

.minimal-content {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px;
  font-size: 12px;
}

.stock-name {
  font-size: 12px;
  font-weight: 600;
  color: #333;
}

.stock-percent {
  font-size: 12px;
  font-weight: 600;
  padding: 4px 8px;
  border-radius: 4px;
  transition: color 0.3s ease;
}

.expanded-wrapper {
  flex: 1;
  padding: 0 16px 16px;
  display: flex;
  flex-direction: column;
  opacity: 0;
  transform: translateY(10px);
  transition: all 0.3s ease 0.1s;
  position: relative;
}

.is-expanded .expanded-wrapper {
  opacity: 1;
  transform: translateY(0);
}

.detail-section {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 8px;
}

.chart-info-header {
  height: 40px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 4px 0;
  font-size: 12px;
  color: #999;
}

.info-time {
  font-weight: 500;
}

.info-price {
  font-weight: 700;
  font-size: 14px;
  display: flex;
  align-items: baseline;
  gap: 6px;
}

.info-percent {
  font-size: 12px;
  font-weight: 500;
}

.floating-tooltip {
  position: absolute;
  left: 0;
  top: 0;
  opacity: 0;
  transform: translateY(4px);
  transition:
    opacity 0.12s ease,
    transform 0.12s ease;
  background: rgba(255, 255, 255, 0.96);
  border: 1px solid #e0e0e0;
  border-radius: 6px;
  padding: 6px 10px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
  pointer-events: none;
  z-index: 10;
  font-size: 12px;
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.floating-tooltip.visible {
  opacity: 1;
  transform: translateY(0);
}

.tooltip-time {
  color: #666;
  font-size: 12px;
}

.tooltip-price {
  display: flex;
  gap: 6px;
  align-items: baseline;
  font-size: 12px;
  .tooltip-label {
    color: #666;
  }
}

.tooltip-price.avg {
  color: #f5a623;
}

.chart-container {
  height: 180px;
  width: 100%;
  background: rgba(0, 0, 0, 0.02);
  border-radius: 4px;
  position: relative;
  overflow: hidden;
}

.up {
  color: #f23645;
}

.up.stock-percent {
  background: rgba(242, 54, 69, 0.12);
}

.down {
  color: #089981;
}

.down.stock-percent {
  background: rgba(8, 153, 129, 0.12);
}
</style>
