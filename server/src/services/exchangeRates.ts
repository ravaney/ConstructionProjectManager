type HistoricalJmdConversion = {
  sourceCurrency: string;
  targetCurrency: "JMD";
  rateDate: string;
  rate: number;
  source: string;
  before: number;
  after: number;
  delta: number;
};

type JmdRateQuote = {
  sourceCurrency: string;
  targetCurrency: "JMD";
  rateDate: string;
  rate: number;
  source: string;
};

type FrankfurterRateRow = {
  date?: string;
  base?: string;
  quote?: string;
  rate?: number;
};

const frankfurterBaseUrl = "https://api.frankfurter.dev/v2/rates";
const historicalRateCache = new Map<string, Promise<{ rateDate: string; rate: number; source: string } | null>>();

function toMoney(value: number): number {
  return Number(Number(value ?? 0).toFixed(2));
}

function toCalendarDate(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return new Date().toISOString().slice(0, 10);
  }

  return date.toISOString().slice(0, 10);
}

async function fetchFrankfurterRate(url: string): Promise<{ rateDate: string; rate: number; source: string } | null> {
  const response = await fetch(url);
  if (!response.ok) {
    return null;
  }

  const payload = (await response.json()) as FrankfurterRateRow[];
  const firstRow = Array.isArray(payload) ? payload[0] : undefined;
  const rate = firstRow?.rate;
  if (typeof rate !== "number" || !Number.isFinite(rate)) {
    return null;
  }

  return {
    rateDate: typeof firstRow?.date === "string" && firstRow.date ? firstRow.date : toCalendarDate(new Date()),
    rate,
    source: "frankfurter.dev"
  };
}

async function getHistoricalJmdRate(date: string, sourceCurrency: string): Promise<{ rateDate: string; rate: number; source: string } | null> {
  const normalizedCurrency = sourceCurrency.trim().toUpperCase();
  if (!normalizedCurrency || normalizedCurrency.length !== 3) {
    return null;
  }

  if (normalizedCurrency === "JMD") {
    return {
      rateDate: date,
      rate: 1,
      source: "identity"
    };
  }

  const cacheKey = `${date}:${normalizedCurrency}:JMD`;
  const existingPromise = historicalRateCache.get(cacheKey);
  if (existingPromise) {
    return existingPromise;
  }

  const pending = (async () => {
    const url = `${frankfurterBaseUrl}?date=${encodeURIComponent(date)}&base=${encodeURIComponent(normalizedCurrency)}&quotes=JMD`;

    try {
      const result = await fetchFrankfurterRate(url);
      if (result) {
        return result;
      }
    } catch {
      // Leave unresolved and return null below.
    }

    return null;
  })();

  historicalRateCache.set(cacheKey, pending);

  const resolved = await pending;
  if (!resolved) {
    historicalRateCache.delete(cacheKey);
  }

  return resolved;
}

export async function buildHistoricalJmdConversion(input: {
  date: string | Date;
  currency?: string;
  before: number;
  after: number;
}): Promise<HistoricalJmdConversion | null> {
  const sourceCurrency = (input.currency ?? "USD").trim().toUpperCase() || "USD";
  const historicalDate = toCalendarDate(input.date);
  const rateResult = await getHistoricalJmdRate(historicalDate, sourceCurrency);
  if (!rateResult) {
    return null;
  }

  return {
    sourceCurrency,
    targetCurrency: "JMD",
    rateDate: rateResult.rateDate,
    rate: toMoney(rateResult.rate),
    source: rateResult.source,
    before: toMoney(input.before * rateResult.rate),
    after: toMoney(input.after * rateResult.rate),
    delta: toMoney((input.after - input.before) * rateResult.rate)
  };
}

export async function getJmdRateQuote(input?: {
  date?: string | Date;
  currency?: string;
}): Promise<JmdRateQuote | null> {
  const sourceCurrency = (input?.currency ?? "USD").trim().toUpperCase() || "USD";
  const targetDate = toCalendarDate(input?.date ?? new Date());
  const rateResult = await getHistoricalJmdRate(targetDate, sourceCurrency);
  if (!rateResult) {
    return null;
  }

  return {
    sourceCurrency,
    targetCurrency: "JMD",
    rateDate: rateResult.rateDate,
    rate: toMoney(rateResult.rate),
    source: rateResult.source
  };
}
