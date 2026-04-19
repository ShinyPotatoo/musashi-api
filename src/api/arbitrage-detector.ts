// Cross-platform arbitrage detector
// Matches markets across Polymarket and Kalshi to find price discrepancies

import { Market, ArbitrageOpportunity } from '../types/market';

const FEES_BPS = Number(process.env.ARB_FEE_BPS || 20);
const SLIPPAGE_BPS = Number(process.env.ARB_SLIPPAGE_BPS || 10);
const LATENCY_BPS = Number(process.env.ARB_LATENCY_BPS || 5);

/**
 * V1.5 Net Edge Calculator
 * Converts raw prices into tradable Basis Points (bps)
 */
function calculateNedEdge(buyPrice: number, sellPrice: number) {
  const grossEdge = sellPrice - buyPrice;
  const grossBps = (grossEdge / buyPrice) * 10000;

  const totalCosts = FEES_BPS + SLIPPAGE_BPS + LATENCY_BPS;
  const netEdgeBps = grossBps - totalCosts;

  return {
    grossBps: Math.round(grossBps),
    netEdgeBps: Math.round(netEdgeBps)
  };
}

/**
 * & Helper to group markets by category for faster scanning (O(N) vs O(N*M))
 */
function groupByCategory(markets: Market[]): Record<string, Market[]> {
  return markets.reduce((acc, market) => {
    const cat = market.category || 'other';
    if (!acc[cat]) acc[cat] = [];
    acc[cat].push(market);
    return acc;
  }, {} as Record<string, Market[]>);
}

/**
 * Normalize a title for fuzzy matching
 * Removes punctuation, dates, common question words, normalizes spacing
 */
function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/\?/g, '') // Remove question marks
    .replace(/\b(will|before|after|by|in|on|at|the|a|an)\b/g, '') // Remove filler words
    .replace(/\b(2024|2025|2026|2027|2028)\b/g, '') // Remove years
    .replace(/[^a-z0-9\s]/g, ' ') // Remove all punctuation
    .replace(/\s+/g, ' ') // Normalize whitespace
    .trim();
}

/**
 * Extract key entities from a market title
 * Looks for: names, tickers, numbers, organizations
 */
function extractEntities(title: string): Set<string> {
  const normalized = normalizeTitle(title);
  const words = normalized.split(' ');
  const entities = new Set<string>();

  // Extract significant words (3+ chars, not in stop list)
  const stopWords = new Set(['will', 'hit', 'reach', 'win', 'lose', 'pass', 'than', 'over', 'under']);

  for (const word of words) {
    if (word.length >= 3 && !stopWords.has(word)) {
      entities.add(word);
    }
  }

  return entities;
}

/**
 * Calculate similarity score between two titles
 * Returns 0-1 based on shared entities
 */
function calculateTitleSimilarity(title1: string, title2: string): number {
  const entities1 = extractEntities(title1);
  const entities2 = extractEntities(title2);

  if (entities1.size === 0 || entities2.size === 0) return 0;

  // Count shared entities
  let sharedCount = 0;
  for (const entity of entities1) {
    if (entities2.has(entity)) {
      sharedCount++;
    }
  }

  // Jaccard similarity: intersection / union
  const union = entities1.size + entities2.size - sharedCount;
  return union > 0 ? sharedCount / union : 0;
}

/**
 * Calculate keyword overlap between two markets
 * Returns the number of shared keywords
 */
function calculateKeywordOverlap(market1: Market, market2: Market): number {
  const keywords1 = new Set(market1.keywords);
  const keywords2 = new Set(market2.keywords);

  let overlap = 0;
  for (const kw of keywords1) {
    if (keywords2.has(kw)) {
      overlap++;
    }
  }

  return overlap;
}

/**
 * Check if two markets refer to the same event
 * Uses title similarity + keyword overlap + category matching
 */
function areMarketsSimilar(poly: Market, kalshi: Market): {
  isSimilar: boolean;
  confidence: number;
  reason: string;
} {
  // Must be in the same category (or one is 'other')
  const categoryMatch = poly.category === kalshi.category ||
                       poly.category === 'other' ||
                       kalshi.category === 'other';

  if (!categoryMatch) {
    return { isSimilar: false, confidence: 0, reason: 'Different categories' };
  }

  // Calculate title similarity
  const titleSim = calculateTitleSimilarity(poly.title, kalshi.title);

  // Calculate keyword overlap
  const keywordOverlap = calculateKeywordOverlap(poly, kalshi);

  // Matching criteria (needs at least one strong signal):
  // 1. High title similarity (>0.5) OR
  // 2. Strong keyword overlap (3+ shared keywords)

  if (titleSim > 0.5) {
    return {
      isSimilar: true,
      confidence: titleSim,
      reason: `High title similarity (${(titleSim * 100).toFixed(0)}%)`
    };
  }

  if (keywordOverlap >= 3) {
    const confidence = Math.min(keywordOverlap / 10, 0.9); // Cap at 0.9
    return {
      isSimilar: true,
      confidence,
      reason: `${keywordOverlap} shared keywords`
    };
  }

  // Check for exact entity matches (strong signal even with low overall similarity)
  const polyEntities = extractEntities(poly.title);
  const kalshiEntities = extractEntities(kalshi.title);
  const sharedEntities = Array.from(polyEntities).filter(e => kalshiEntities.has(e));

  if (sharedEntities.length >= 2 && titleSim > 0.3) {
    return {
      isSimilar: true,
      confidence: 0.7,
      reason: `Shared entities: ${sharedEntities.slice(0, 3).join(', ')}`
    };
  }

  return { isSimilar: false, confidence: 0, reason: 'Insufficient similarity' };
}

/**
 * Detect arbitrage opportunities across Polymarket and Kalshi
 *
 * @param markets - Combined array of markets from both platforms
 * @param minSpread - Minimum spread to be considered an opportunity (default: 0.03 = 3%)
 * @returns Array of arbitrage opportunities sorted by spread (highest first)
 */
export function detectArbitrage(
  markets: Market[],
  minNetEdgeBps: number = 50
): ArbitrageOpportunity[] {
    const opportunities: ArbitrageOpportunity[] = [];

    // Separate markets by platform
    const polyByCat = groupByCategory(markets.filter(m => m.platform === 'polymarket'));
    const kalshiByCat = groupByCategory(markets.filter(m => m.platform === 'kalshi'));

    // Compare each Polymarket market with each Kalshi market
    for (const cat in polyByCat) {
      if (!kalshiByCat[cat]) continue;

      for (const poly of polyByCat[cat]) {
        for (const kalshi of kalshiByCat[cat]) {
        // Date Check
        if (poly.endDate && kalshi.endDate) {
          const delta = Math.abs(new Data(poly.endDate).getTime() - new Date(kalshi.endDate).getTime());
          if (delta > 86400000) continue;
        }

        const similarity = areMarketsSimilar(poly, kalshi);

        if (!similarity.isSimilar) continue;

        // Calculate spread
        const spread = Math.abs(poly.yesPrice - kalshi.yesPrice);

        if (spread < minSpread) continue;

        // Math
        const isPolyCheaper = poly.yesPrice < kalshi.yesPrice;
        const buyPrice = isPolyCheaper ? poly.yesPrice : kalshi.yesPrice;
        const sellPrice = isPolyCheaper ? kalshi.yesPrice : poly.yesPrice;

        const { grossBps, netEdgeBps } = calculateNetEdge(buyPrice, sellPrice);

        if (netEdgeBps < minNetEdgeBps) continue;

        // V1.5 Objects
        opportunities.push({
          polymarket: poly,
          kalshi: kalshi,
          buyPrice,
          sellPrice,
          buyVenue: isPolyCheaper ? 'polymarket' : 'kalshi',
          sellVenue: isPolyCheaper ? 'kalshi' : 'polymarket',
          netEdgeBps,
          grossEdgeBps: grossBps,
          estimatedFeesBps: FEES_BPS,
          slippageBps: SLIPPAGE_BPS,
          latencyRiskBps: LATENCY_BPS,
          confidence: similarity.confidence,
          matchReason: similarity.reason,
          liquidityScore: 0.5,
          expiryDeltaMinutes: poly.endDate ? Math.floor((new Date(poly.endDate).getTime() - Date.now()) / 60000) :0,
          asOfTs: new Date().toISOString(),

          spread: sellPrice - buyPrice,
          profitPotential: (sellPrice - buyPrice),
          direction: isPolyCheaper ? 'buy_poly_sell_kalshi' : 'buy_kalshi_sell_poly'
        });
      }
    }
  }
  return opportunities.sort((a, b) => b.netEdgeBps - a.netEdgeBps);
}

/**
 * Get top arbitrage opportunities
 * Filters by minimum spread and confidence, returns top N
 */
export function getTopArbitrage(
  markets: Market[],
  options: {
    minNetEdgeBps?: number;
    limit?: number;
    category?: string;
  } = {}
): ArbitrageOpportunity[] {
  const {
    minNetEdgeBps = 50,
    limit = 20,
    category,
  } = options;

  let opportunities = detectArbitrage(markets, minNetEdgeBps);

  // Filter by category if specified
  if (category) {
    opportunities = opportunities.filter(
      op => op.polymarket.category === category || op.kalshi.category === category
    );
  }

  // Return top N
  return opportunities.slice(0, limit);
}
