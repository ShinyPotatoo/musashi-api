import type { VercelRequest, VercelResponse } from '@vercel/node';
import type { MarketWalletFlow, SmartMoneyMarket } from '../../src/types/wallet';
import { getMarketMetadata, getMarkets } from '../lib/market-cache';
import {
  getCachedSmartMoneyMarkets,
  getSmartMoneyMarketsKey,
  getStaleWalletMemoryCache,
  setCachedSmartMoneyMarkets,
} from '../lib/wallet-cache';
import { getSmartMoneyMarkets as rankSmartMoneyMarkets } from '../lib/smart-money';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const DEFAULT_MIN_VOLUME = 0;
const DEFAULT_WINDOW: MarketWalletFlow['window'] = '24h';
const VALID_WINDOWS = new Set(['1h', '24h', '7d']);

interface SmartMoneyMarketsFilters {
  category?: string;
  window: MarketWalletFlow['window'];
  minVolume: number;
  limit: number;
}

interface SmartMoneyMarketsResponse {
  success: true;
  data: {
    markets: SmartMoneyMarket[];
    count: number;
  };
  filters: SmartMoneyMarketsFilters;
  timestamp: string;
  metadata: {
    source: 'polymarket';
    processing_time_ms: number;
    cached: boolean;
    cached_at?: string | null;
    cache_age_seconds: number | null;
    candidates_analyzed: number;
    flow_results: number;
    data_age_seconds?: number;
    fetched_at?: string;
    sources?: Record<string, unknown>;
  };
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, OPTIONS');
    res.status(405).json({
      success: false,
      error: 'Method not allowed. Use GET.',
    });
    return;
  }

  const startTime = Date.now();

  try {
    const filters = parseFilters(req);
    if ('error' in filters) {
      res.status(400).json({
        success: false,
        error: filters.error,
      });
      return;
    }

    const cached = await getCachedSmartMoneyMarkets(
      filters.category,
      filters.window,
      filters.minVolume,
      filters.limit,
    );

    if (cached) {
      res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
      res.status(200).json(buildResponse(
        filters,
        cached.data,
        startTime,
        true,
        cached.cached_at,
        cached.cache_age_seconds,
        0,
        cached.data.length,
      ));
      return;
    }

    const markets = await getMarkets();
    if (markets.length === 0) {
      res.status(503).json({
        success: false,
        error: 'No markets available. Service temporarily unavailable.',
      });
      return;
    }

    const result = await rankSmartMoneyMarkets(markets, filters);
    await setCachedSmartMoneyMarkets(
      filters.category,
      filters.window,
      filters.minVolume,
      filters.limit,
      result.markets,
    );

    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
    res.status(200).json(buildResponse(
      filters,
      result.markets,
      startTime,
      false,
      null,
      null,
      result.candidatesAnalyzed,
      result.flowResults,
    ));
  } catch (error) {
    const fallback = getStaleSmartMoneyMarkets(req);
    if (fallback) {
      res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=120');
      res.status(200).json(buildResponse(
        fallback.filters,
        fallback.markets,
        startTime,
        true,
        fallback.cachedAt,
        fallback.cacheAgeSeconds,
        0,
        fallback.markets.length,
      ));
      return;
    }

    console.error('[Smart Money Markets API] Error:', error);
    res.status(503).json({
      success: false,
      error: 'Smart-money markets temporarily unavailable. Try again later.',
      metadata: {
        processing_time_ms: Date.now() - startTime,
      },
    });
  }
}

/**
 * Parse and validate smart-money query filters.
 *
 * @param req Vercel request with category/window filters.
 */
function parseFilters(req: VercelRequest): SmartMoneyMarketsFilters | { error: string } {
  const category = getSingleQueryValue(req.query.category)?.trim();

  const window = parseWindow(getSingleQueryValue(req.query.window));
  if (typeof window === 'string') {
    return { error: window };
  }

  const minVolume = parseMinVolume(getSingleQueryValue(req.query.minVolume));
  if (typeof minVolume === 'string') {
    return { error: minVolume };
  }

  const limit = parseLimit(getSingleQueryValue(req.query.limit));
  if (typeof limit === 'string') {
    return { error: limit };
  }

  return {
    category: category || undefined,
    window,
    minVolume,
    limit,
  };
}

/**
 * Build the smart-money response envelope.
 *
 * @param filters Validated query filters.
 * @param markets Ranked smart-money markets.
 * @param startTime Request start time in milliseconds.
 * @param cached Whether the data came from cache.
 * @param cachedAt Cache write timestamp.
 * @param cacheAgeSeconds Cache age in seconds.
 * @param candidatesAnalyzed Candidate market count.
 * @param flowResults Markets with usable wallet flow.
 */
function buildResponse(
  filters: SmartMoneyMarketsFilters,
  markets: SmartMoneyMarket[],
  startTime: number,
  cached: boolean,
  cachedAt: string | null,
  cacheAgeSeconds: number | null,
  candidatesAnalyzed: number,
  flowResults: number,
): SmartMoneyMarketsResponse {
  const freshness = getMarketMetadata();

  return {
    success: true,
    data: {
      markets,
      count: markets.length,
    },
    filters,
    timestamp: new Date().toISOString(),
    metadata: {
      source: 'polymarket',
      processing_time_ms: Date.now() - startTime,
      cached,
      cached_at: cachedAt,
      cache_age_seconds: cacheAgeSeconds,
      candidates_analyzed: candidatesAnalyzed,
      flow_results: flowResults,
      data_age_seconds: freshness.data_age_seconds,
      fetched_at: freshness.fetched_at,
      sources: freshness.sources,
    },
  };
}

function getStaleSmartMoneyMarkets(req: VercelRequest): {
  filters: SmartMoneyMarketsFilters;
  markets: SmartMoneyMarket[];
  cachedAt: string | null;
  cacheAgeSeconds: number | null;
} | null {
  const filters = parseFilters(req);
  if ('error' in filters) return null;

  const key = getSmartMoneyMarketsKey(
    filters.category,
    filters.window,
    filters.minVolume,
    filters.limit,
  );
  const stale = getStaleWalletMemoryCache<SmartMoneyMarket[]>(key);
  if (!stale) return null;

  return {
    filters,
    markets: stale.data,
    cachedAt: stale.cached_at,
    cacheAgeSeconds: stale.cache_age_seconds,
  };
}

function parseWindow(value: string | undefined): MarketWalletFlow['window'] | string {
  if (value === undefined) return DEFAULT_WINDOW;
  if (!VALID_WINDOWS.has(value)) {
    return 'Invalid window. Must be one of 1h, 24h, or 7d.';
  }
  return value as MarketWalletFlow['window'];
}

function parseMinVolume(value: string | undefined): number | string {
  if (value === undefined) return DEFAULT_MIN_VOLUME;

  if (!/^\d+(\.\d+)?$/.test(value)) {
    return 'Invalid minVolume. Must be greater than or equal to 0.';
  }

  const minVolume = Number.parseFloat(value);
  if (!Number.isFinite(minVolume) || minVolume < 0) {
    return 'Invalid minVolume. Must be greater than or equal to 0.';
  }

  return minVolume;
}

function parseLimit(value: string | undefined): number | string {
  if (value === undefined) return DEFAULT_LIMIT;

  if (!/^\d+$/.test(value)) {
    return `Invalid limit. Must be between 1 and ${MAX_LIMIT}.`;
  }

  const limit = Number.parseInt(value, 10);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    return `Invalid limit. Must be between 1 and ${MAX_LIMIT}.`;
  }

  return limit;
}

function getSingleQueryValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
