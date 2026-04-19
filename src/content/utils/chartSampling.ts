export interface ChartPoint {
  time: number;
  value: number;
}

interface Bucket {
  first: ChartPoint | null;
  last: ChartPoint | null;
  min: ChartPoint | null;
  max: ChartPoint | null;
}

const createBucket = (): Bucket => ({
  first: null,
  last: null,
  min: null,
  max: null,
});

const appendUnique = (target: ChartPoint[], source: ChartPoint[]) => {
  for (const point of source) {
    if (target.length === 0) {
      target.push(point);
      continue;
    }

    const last = target[target.length - 1];
    if (last.time === point.time && last.value === point.value) continue;
    target.push(point);
  }
};

export function sampleChartDataByWidth<T extends ChartPoint>(data: T[], widthPx: number): T[] {
  if (data.length <= 2) return data.slice();

  const safeWidth = Number.isFinite(widthPx) ? Math.max(0, Math.floor(widthPx)) : 0;
  if (safeWidth <= 0) return data.slice();

  const maxPoints = Math.max(16, Math.floor(safeWidth * 1.5));
  if (data.length <= maxPoints) return data.slice();

  const bucketCount = Math.max(1, Math.floor(maxPoints / 4));
  const firstTime = data[0].time;
  const lastTime = data[data.length - 1].time;
  const timeSpan = Math.max(1, lastTime - firstTime + 1);
  const buckets = Array.from({ length: bucketCount }, createBucket);

  for (const point of data) {
    const ratio = (point.time - firstTime) / timeSpan;
    const index = Math.min(bucketCount - 1, Math.max(0, Math.floor(ratio * bucketCount)));
    const bucket = buckets[index];

    if (!bucket.first) bucket.first = point;
    bucket.last = point;
    if (!bucket.min || point.value < bucket.min.value) bucket.min = point;
    if (!bucket.max || point.value > bucket.max.value) bucket.max = point;
  }

  const sampled: T[] = [];
  for (const bucket of buckets) {
    if (!bucket.first) continue;

    const points = [bucket.first, bucket.min, bucket.max, bucket.last]
      .filter((point): point is ChartPoint => point !== null)
      .sort((a, b) => a.time - b.time);

    appendUnique(sampled, points);
  }

  if (sampled.length >= 2) return sampled;
  return [data[0], data[data.length - 1]];
}
