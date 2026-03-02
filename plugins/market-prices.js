// plugins/market-prices.js
//
// Fetches a live market snapshot:
//   • Top 5 cryptocurrencies (BTC, ETH, BNB, SOL, XRP) via CoinGecko (free, no key)
//   • S&P 500 index via Yahoo Finance (free, no key)
//   • Gold, Silver, Petrol – prices per gram, kg, oz and litre (petrol)
//     via metals-api free tier (gold/silver) and Yahoo Finance (crude oil)
//
// All data is fetched in parallel for speed.
// No API key required – uses only free public endpoints.

const COINGECKO_URL =
  'https://api.coingecko.com/api/v3/simple/price' +
  '?ids=bitcoin,ethereum,binancecoin,solana,ripple' +
  '&vs_currencies=usd' +
  '&include_24hr_change=true' +
  '&include_market_cap=true';

// Yahoo Finance v8 chart endpoint – works without authentication
const YAHOO_URL = (ticker) =>
  `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=1d`;

// Troy ounce conversions
const TROY_OZ_TO_GRAM  = 31.1035;
const TROY_OZ_TO_KG    = 0.0311035;

// ─── helpers ────────────────────────────────────────────────────────────────

async function fetchJson(url, label) {
  const resp = await fetch(url, {
    headers: { 'User-Agent': 'SubaruPlugin/1.0' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) throw new Error(`${label}: HTTP ${resp.status}`);
  return resp.json();
}

function fmt(n, decimals = 2) {
  if (n == null || isNaN(n)) return 'N/A';
  return n.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function fmtChange(pct) {
  if (pct == null || isNaN(pct)) return '';
  const sign = pct >= 0 ? '+' : '';
  return ` (${sign}${fmt(pct)}% 24h)`;
}

// ─── fetchers ────────────────────────────────────────────────────────────────

async function getCrypto() {
  const data = await fetchJson(COINGECKO_URL, 'CoinGecko');
  const coins = [
    { id: 'bitcoin',     symbol: 'BTC' },
    { id: 'ethereum',    symbol: 'ETH' },
    { id: 'binancecoin', symbol: 'BNB' },
    { id: 'solana',      symbol: 'SOL' },
    { id: 'ripple',      symbol: 'XRP' },
  ];
  return coins.map(({ id, symbol }) => {
    const c = data[id] || {};
    return {
      symbol,
      price: c.usd,
      change24h: c.usd_24h_change,
      marketCap: c.usd_market_cap,
    };
  });
}

async function getYahooPrice(ticker) {
  const data = await fetchJson(YAHOO_URL(ticker), `Yahoo(${ticker})`);
  const result = data?.chart?.result?.[0];
  const meta   = result?.meta;
  if (!meta) throw new Error(`No data returned for ${ticker}`);
  // regularMarketPrice is the most recent price
  return meta.regularMarketPrice ?? meta.previousClose;
}

async function getSP500() {
  return getYahooPrice('^GSPC');
}

// Gold spot price: GC=F is COMEX gold futures ($/troy oz) – close enough for display
async function getGold() {
  const pricePerOz = await getYahooPrice('GC=F');
  return {
    perOz:   pricePerOz,
    perGram: pricePerOz / TROY_OZ_TO_GRAM,
    perKg:   pricePerOz / TROY_OZ_TO_GRAM * 1000,
  };
}

// Silver spot: SI=F is COMEX silver futures ($/troy oz)
async function getSilver() {
  const pricePerOz = await getYahooPrice('SI=F');
  return {
    perOz:   pricePerOz,
    perGram: pricePerOz / TROY_OZ_TO_GRAM,
    perKg:   pricePerOz / TROY_OZ_TO_GRAM * 1000,
  };
}

// Crude oil: CL=F is WTI crude futures ($/barrel)
// 1 barrel = 158.987 litres, 1 barrel ≈ 136.4 kg ≈ 134,000 ml
const BARREL_TO_LITRE = 158.987;
const BARREL_TO_KG    = 136.4;        // approximate (varies by grade)
const BARREL_TO_GRAM  = BARREL_TO_KG * 1000;

async function getPetrol() {
  const pricePerBarrel = await getYahooPrice('CL=F');
  return {
    perBarrel: pricePerBarrel,
    perLitre:  pricePerBarrel / BARREL_TO_LITRE,
    perGram:   pricePerBarrel / BARREL_TO_GRAM,
    perKg:     pricePerBarrel / BARREL_TO_KG,
  };
}

// ─── plugin definition ───────────────────────────────────────────────────────

export default {
  name: 'get_market_snapshot',

  description: `Fetches a live market snapshot covering:
- Top 5 cryptocurrencies by market cap (BTC, ETH, BNB, SOL, XRP): USD price, 24h change, market cap
- S&P 500 index: current level
- Gold: price per gram, kg, and troy oz (USD)
- Silver: price per gram, kg, and troy oz (USD)
- Crude oil / petrol: price per litre, gram, and kg (USD, WTI spot)
All prices are fetched in parallel from free public APIs (CoinGecko + Yahoo Finance).
Use this whenever the user asks about current crypto prices, stock index levels, commodity prices, or a general market overview.`,

  parameters: {
    type: 'object',
    properties: {
      include_market_cap: {
        type: 'boolean',
        description: 'Whether to include market cap figures for crypto. Default: true.',
        default: true,
      },
    },
    required: [],
  },

  execute: async ({ include_market_cap = true }, context) => {
    context.logger.info('Fetching market snapshot…');

    // Fire all requests in parallel
    const [cryptoResult, sp500Result, goldResult, silverResult, petrolResult] =
      await Promise.allSettled([
        getCrypto(),
        getSP500(),
        getGold(),
        getSilver(),
        getPetrol(),
      ]);

    const lines = [];
    const errors = [];

    // ── Crypto ──────────────────────────────────────────────────────────────
    lines.push('═══ TOP 5 CRYPTOCURRENCIES ═══');
    if (cryptoResult.status === 'fulfilled') {
      for (const coin of cryptoResult.value) {
        let line = `  ${coin.symbol.padEnd(4)}  $${fmt(coin.price)}${fmtChange(coin.change24h)}`;
        if (include_market_cap && coin.marketCap) {
          const mc = (coin.marketCap / 1e9).toFixed(1);
          line += `  [MCap $${mc}B]`;
        }
        lines.push(line);
      }
    } else {
      errors.push(`Crypto: ${cryptoResult.reason?.message}`);
      lines.push('  Data unavailable');
    }

    // ── S&P 500 ─────────────────────────────────────────────────────────────
    lines.push('');
    lines.push('═══ S&P 500 ═══');
    if (sp500Result.status === 'fulfilled') {
      lines.push(`  Level: ${fmt(sp500Result.value)}`);
    } else {
      errors.push(`S&P 500: ${sp500Result.reason?.message}`);
      lines.push('  Data unavailable');
    }

    // ── Gold ────────────────────────────────────────────────────────────────
    lines.push('');
    lines.push('═══ GOLD (USD) ═══');
    if (goldResult.status === 'fulfilled') {
      const g = goldResult.value;
      lines.push(`  Per troy oz : $${fmt(g.perOz)}`);
      lines.push(`  Per gram    : $${fmt(g.perGram, 4)}`);
      lines.push(`  Per kg      : $${fmt(g.perKg)}`);
    } else {
      errors.push(`Gold: ${goldResult.reason?.message}`);
      lines.push('  Data unavailable');
    }

    // ── Silver ──────────────────────────────────────────────────────────────
    lines.push('');
    lines.push('═══ SILVER (USD) ═══');
    if (silverResult.status === 'fulfilled') {
      const s = silverResult.value;
      lines.push(`  Per troy oz : $${fmt(s.perOz)}`);
      lines.push(`  Per gram    : $${fmt(s.perGram, 4)}`);
      lines.push(`  Per kg      : $${fmt(s.perKg)}`);
    } else {
      errors.push(`Silver: ${silverResult.reason?.message}`);
      lines.push('  Data unavailable');
    }

    // ── Petrol (WTI crude) ──────────────────────────────────────────────────
    lines.push('');
    lines.push('═══ CRUDE OIL / PETROL – WTI (USD) ═══');
    if (petrolResult.status === 'fulfilled') {
      const p = petrolResult.value;
      lines.push(`  Per barrel  : $${fmt(p.perBarrel)}`);
      lines.push(`  Per litre   : $${fmt(p.perLitre, 4)}`);
      lines.push(`  Per gram    : $${fmt(p.perGram, 6)}`);
      lines.push(`  Per kg      : $${fmt(p.perKg, 4)}`);
    } else {
      errors.push(`Petrol: ${petrolResult.reason?.message}`);
      lines.push('  Data unavailable');
    }

    // ── Footer ──────────────────────────────────────────────────────────────
    lines.push('');
    lines.push(`Data sources: CoinGecko (crypto) · Yahoo Finance (S&P 500, metals futures, WTI crude)`);
    lines.push(`Prices are indicative / delayed. Not financial advice.`);

    if (errors.length > 0) {
      lines.push('');
      lines.push(`⚠ Partial errors: ${errors.join(' | ')}`);
    }

    context.logger.info(`Market snapshot complete. Errors: ${errors.length}`);

    return {
      success: true,
      output: lines.join('\n'),
    };
  },
};