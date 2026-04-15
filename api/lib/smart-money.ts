import type { Market } from '../../src/types/market';
import type { MarketWalletFlow, SmartMoneyMarket } from '../../src/types/wallet';
import { getMarketWalletFlow } from './wallet-flow';

export interface SmartMoneyMarketsInput {
  /** Optional Musashi category filter. */
  category?: string;
  /** Wallet-flow aggregation window. */
  window: MarketWalletFlow['window'];
  /** Minimum total wallet-flow volume. */
  minVolume: number;
  /** Max ranked markets to return. */
  limit: number;
  /** Activity rows requested per market. */
  flowLimit?: number;
  /** Candidate markets analyzed before ranking. */
  candidateLimit?: number;
}

export interface SmartMoneyMarketsResult {
  markets: SmartMoneyMarket[];
  candidatesAnalyzed: number;
  flowResults: number;
}

const DEFAULT_CANDIDATE_LIMIT = parsePositiveInt(process.env.SMART_MONEY_CANDIDATE_LIMIT, 40);
const MAX_CANDIDATE_LIMIT = parsePositiveInt(process.env.SMART_MONEY_MAX_CANDIDATES, 100);
const DEFAULT_FLOW_LIMIT = parsePositiveInt(process.env.SMART_MONEY_FLOW_ACTIVITY_LIMIT, 50);
const FLOW_BATCH_SIZE = parsePositiveInt(process.env.SMART_MONEY_FLOW_BATCH_SIZE, 5);

/**
 * Rank Polymarket markets by recent smart-wallet flow.
 *
 * @param allMarkets Cached Musashi market list.
 * @param input Ranking filters and limits.
 */
export async function getSmartMoneyMarkets(
  allMarkets: Market[],
  input: SmartMoneyMarketsInput,
): Promise<SmartMoneyMarketsResult> {
  const candidates = selectCandidates(allMarkets, input);
  const flowResults = await collectMarketFlows(candidates, input);
  const ranked = flowResults
    .map(({ market, flow }) => toSmartMoneyMarket(market, flow))
    .filter((market): market is SmartMoneyMarket =>
      market !== null && getFlowVolume(market.flow) >= input.minVolume
    )
    .sort((a, b) => b.score - a.score)
    .slice(0, input.limit);

  return {
    markets: ranked,
    candidatesAnalyzed: candidates.length,
    flowResults: flowResults.length,
  };
}

function selectCandidates(markets: Market[], input: SmartMoneyMarketsInput): Market[] {
  const category = input.category?.trim().toLowerCase();
  const candidateLimit = normalizeCandidateLimit(input);

  return markets
    .filter(market => market.platform === 'polymarket')
    .filter(market => !category || market.category.toLowerCase() === category)
    .sort((a, b) => getMarketActivityScore(b) - getMarketActivityScore(a))
    .slice(0, candidateLimit);
}

async function collectMarketFlows(
  candidates: Market[],
  input: SmartMoneyMarketsInput,
): Promise<Array<{ market: Market; flow: MarketWalletFlow }>> {
  const rows: Array<{ market: Market; flow: MarketWalletFlow }> = [];
  const flowLimit = normalizeFlowLimit(input.flowLimit);

  for (let index = 0; index < candidates.length; index += FLOW_BATCH_SIZE) {
    const batch = candidates.slice(index, index + FLOW_BATCH_SIZE);
    const settled = await Promise.allSettled(
      batch.map(async market => {
        const result = await getMarketWalletFlow({
          marketId: market.id,
          window: input.window,
          limit: flowLimit,
        }, candidates);
        return { market, flow: result.flow };
      }),
    );

    for (const result of settled) {
      if (result.status === 'fulfilled' && hasMeaningfulFlow(result.value.flow)) {
        rows.push(result.value);
      }
    }
  }

  return rows;
}

function toSmartMoneyMarket(market: Market, flow: MarketWalletFlow): SmartMoneyMarket | null {
  if (!hasMeaningfulFlow(flow)) return null;

  return {
    marketId: flow.marketId || market.id,
    conditionId: flow.conditionId || stripPolymarketPrefix(market.id),
    tokenId: flow.tokenId,
    marketTitle: flow.marketTitle || market.title,
    category: market.category,
    url: market.url,
    score: scoreSmartMoneyMarket(market, flow),
    flow: {
      ...flow,
      marketId: flow.marketId || market.id,
      conditionId: flow.conditionId || stripPolymarketPrefix(market.id),
      marketTitle: flow.marketTitle || market.title,
    },
  };
}

function scoreSmartMoneyMarket(market: Market, flow: MarketWalletFlow): number {
  const totalFlow = getFlowVolume(flow);
  const netFlow = Math.abs(flow.netVolume);
  const walletSignal = flow.walletCount * 75;
  const smartWalletSignal = flow.smartWalletCount * 250;
  const marketVolumeSignal = Math.log10(Math.max(0, market.volume24h) + 1) * 100;
  const priceMoveSignal = Math.abs(market.oneDayPriceChange || 0) * 1000;
  const directionSignal = flow.netDirection === 'unknown' ? 0 : 100;

  return roundScore(
    netFlow +
      (totalFlow * 0.25) +
      walletSignal +
      smartWalletSignal +
      marketVolumeSignal +
      priceMoveSignal +
      directionSignal,
  );
}

function hasMeaningfulFlow(flow: MarketWalletFlow): boolean {
  return flow.smartWalletCount > 0 && getFlowVolume(flow) > 0;
}

function getFlowVolume(flow: MarketWalletFlow): number {
  return Math.max(0, flow.buyVolume) + Math.max(0, flow.sellVolume);
}

function getMarketActivityScore(market: Market): number {
  const priceMove = Math.abs(market.oneDayPriceChange || 0) * 1000;
  return Math.max(0, market.volume24h) + priceMove;
}

function normalizeCandidateLimit(input: SmartMoneyMarketsInput): number {
  const requested = input.candidateLimit ?? Math.max(DEFAULT_CANDIDATE_LIMIT, input.limit * 4);
  const lowerBound = Math.max(1, input.limit);
  const upperBound = Math.max(lowerBound, MAX_CANDIDATE_LIMIT);
  return clampInteger(requested, lowerBound, upperBound);
}

function normalizeFlowLimit(value: number | undefined): number {
  return clampInteger(value ?? DEFAULT_FLOW_LIMIT, 1, 100);
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function roundScore(value: number): number {
  return Math.round(value * 100) / 100;
}

function stripPolymarketPrefix(marketId: string): string | undefined {
  const stripped = marketId.replace(/^polymarket-/i, '').trim();
  return stripped || undefined;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
