// Early-Rise Pyramid — an original pump.fun paper-trading strategy.
//
// Idea (mine, written for this competition): new pump.fun coins usually pump
// hard in their first minutes and then revert toward their creation price,
// and they almost never fall far below it — so the reversion floor, not a
// stop-loss, caps the downside. This bot buys only coins that already prove
// early buying pressure, buys SMALL at first, and pyramids up only while the
// curve keeps attracting net buys:
//
//   * First buy 0.01 SOL (exactly the competition's round-trip floor) once a
//     young coin shows 2+ trades, 2+ buys, buy volume >= half of all volume,
//     price up >= 5% from creation, and >= 1 SOL of real reserves (so the
//     harness's 1%-of-reserve size cap allows the buy).
//   * Add 0.01 SOL more each time real reserves have grown 1.5x since the
//     last buy, up to 0.05 SOL per coin. Add-ons average the entry price down
//     toward the early, cheap part of the pump instead of chasing the top.
//   * Exit the whole position at +30% over the average entry price, on a
//     trailing stop 30% below the best price seen since entry, or after
//     20,000 slots held. No hard stop-loss: prices revert to creation price,
//     they do not crash through it.
//
// At most 5 open positions. Everything is deterministic: decisions come only
// from the replay feed, never from the clock, the environment or randomness.
//
// Wire protocol: agent-fun/replay/v2, spoken through the vendored SDK shim
// (vendor/makefun-bot.ts, a byte-identical copy of the kit's sdk/ts file).

import {
  LAMPORTS_PER_SOL,
  runBot,
  type Batch,
  type BotState,
  type BuyInput,
  type OrderInput,
  type SellInput,
} from './vendor/makefun-bot.ts';

// ------------------------------------------------------------------ tuning

/** Total budget per coin (SOL): first buy plus pyramid add-ons. */
const BUDGET_LAMPORTS = (LAMPORTS_PER_SOL * 5n) / 100n; // 0.05 SOL
/** First buy per coin (SOL): exactly the guardrail's round-trip floor. */
const FIRST_BUY_LAMPORTS = (LAMPORTS_PER_SOL * 1n) / 100n; // 0.01 SOL
/** Size of each pyramid add-on buy (SOL). */
const ADD_CHUNK_LAMPORTS = (LAMPORTS_PER_SOL * 1n) / 100n; // 0.01 SOL
/** Smallest buy worth paying the transaction fee for (SOL). */
const MIN_BUY_LAMPORTS = (LAMPORTS_PER_SOL * 1n) / 100n; // 0.01 SOL
/** Entry needs this much real SOL in the curve so the size cap allows MIN_BUY. */
const MIN_REAL_SOL = 1n * LAMPORTS_PER_SOL;
/** Entry: price must be up this much from the creation price (105 = +5%). */
const ENTRY_RISE_NUM = 105n;
const ENTRY_RISE_DEN = 100n;
/** Entry: at least this many trades and buys since creation. */
const ENTRY_MIN_TRADES = 2;
const ENTRY_MIN_BUYS = 2;
/** Entry: buy volume must be at least this share of all volume (50%). */
const ENTRY_BUY_SHARE_NUM = 50n;
const ENTRY_BUY_SHARE_DEN = 100n;
/** Entry: only coins this young (slots since creation). */
const ENTRY_MAX_AGE_SLOTS = 5000;
/** Add-on: real reserves must have grown this much since the last buy (3/2). */
const REGROW_NUM = 3n;
const REGROW_DEN = 2n;
/** Exit: take profit at +30% over the average entry price. */
const TAKE_PROFIT_NUM = 130n;
const TAKE_PROFIT_DEN = 100n;
/** Exit: trailing stop 30% below the best price seen since entry. */
const TRAILING_NUM = 70n;
const TRAILING_DEN = 100n;
/** Exit: give up on a flat position after this many slots. No hard stop-loss:
    a pump.fun price almost never falls far below its creation price, so the
    reversion floor, not a stop, caps the downside. */
const MAX_HOLD_SLOTS = 20000;
/** Slippage left wide open: a 2-slot latency move must never reject a fill. */
const MAX_SLIPPAGE_BPS = 10_000;

// ------------------------------------------------------------------ state

/** A price as an exact fraction: lamports per token = num / den. */
interface Price {
  num: bigint;
  den: bigint;
}

/** What we remember about a coin from its CreateEvent onward. */
interface CoinTrack {
  createdSlot: number;
  p0: Price;
  trades: number;
  buys: number;
  buyVol: bigint;
  sellVol: bigint;
  peak: Price;
  /** Entry already decided (bought, or skipped for good). */
  decided: boolean;
  /** Real SOL reserves when the last buy on this coin was decided. */
  lastBuyReal: bigint;
}

/** What we remember about a position we hold. */
interface PositionTrack {
  /** Average entry price (lamports per token, fees included) = paid / tokens,
      accumulated over every buy fill on this coin. */
  entry: Price;
  /** Best price seen since the first buy fill. */
  peak: Price;
  entrySlot: number;
  /** Total SOL paid for buys on this coin (the guardrail's round-trip size). */
  invested: bigint;
  /** Real SOL reserves when the last buy on this coin was decided. */
  lastBuyReal: bigint;
}

const coins = new Map<string, CoinTrack>();
const held = new Map<string, PositionTrack>();

// ------------------------------------------------------- exact price maths

/** Current price of a curve from its virtual reserves. */
function curvePrice(virtualQuote: bigint, virtualToken: bigint): Price {
  return { num: virtualQuote, den: virtualToken };
}

/** True when price a is at least ref * (p / q). */
function atLeast(a: Price, ref: Price, p: bigint, q: bigint): boolean {
  return a.num * ref.den * q >= ref.num * a.den * p;
}

/** True when price a is at most ref * (p / q). */
function atMost(a: Price, ref: Price, p: bigint, q: bigint): boolean {
  return a.num * ref.den * q <= ref.num * a.den * p;
}

/** True when price a is above price b. */
function above(a: Price, b: Price): boolean {
  return a.num * b.den > b.num * a.den;
}

// ------------------------------------------------------------- fill intake

/** Record buy fills so exits know the true average entry price (fees
    included) and how much this round trip has bought in total. */
function recordFills(batch: Batch): void {
  for (const fill of batch.fills) {
    if (fill.side !== 'buy' || fill.status !== 'filled') continue;
    const tokens = BigInt(fill.token_amount);
    const paid = BigInt(fill.quote_lamports);
    if (tokens <= 0n || paid <= 0n) continue;
    const track = coins.get(fill.mint);
    const prev = held.get(fill.mint);
    if (prev === undefined) {
      const entry: Price = { num: paid, den: tokens };
      held.set(fill.mint, {
        entry,
        peak: entry,
        entrySlot: batch.slot,
        invested: paid,
        lastBuyReal: track === undefined ? 0n : track.lastBuyReal,
      });
    } else {
      // Volume-weighted average entry price across all buys on this coin.
      prev.entry = { num: prev.entry.num + paid, den: prev.entry.den + tokens };
      if (above({ num: paid, den: tokens }, prev.peak)) prev.peak = { num: paid, den: tokens };
      prev.invested += paid;
      if (track !== undefined) prev.lastBuyReal = track.lastBuyReal;
    }
  }
  // Harness closes (complete / flatten / writeoff) drop the position.
  for (const [mint] of held) {
    if (!batch.account.positions.some((p) => p.mint === mint)) held.delete(mint);
  }
}

// ------------------------------------------------------------- entry + exit
// (implemented in the edits below)

/** Fold this batch's events into the per-coin tracks. */
function trackEvents(batch: Batch): void {
  for (const e of batch.events) {
    if (e.event === 'CreateEvent') {
      const p0 = curvePrice(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
      coins.set(e.mint, {
        createdSlot: e.slot,
        p0,
        trades: 0,
        buys: 0,
        buyVol: 0n,
        sellVol: 0n,
        peak: p0,
        decided: false,
        lastBuyReal: 0n,
      });
    } else if (e.event === 'TradeEvent') {
      const track = coins.get(e.mint);
      if (track === undefined) continue;
      const price = curvePrice(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
      track.trades += 1;
      if (above(price, track.peak)) track.peak = price;
      if (e.is_buy) {
        track.buys += 1;
        track.buyVol += BigInt(e.sol_amount);
      } else {
        track.sellVol += BigInt(e.sol_amount);
      }
    } else {
      // CompleteEvent: the curve is done, never enter it.
      const track = coins.get(e.mint);
      if (track !== undefined) track.decided = true;
    }
  }
  // Forget coins that aged out of the entry window without ever qualifying.
  for (const [mint, track] of coins) {
    if (!track.decided && batch.slot - track.createdSlot > ENTRY_MAX_AGE_SLOTS) track.decided = true;
  }
}

function evaluateEntries(state: BotState, batch: Batch, selling: ReadonlySet<string>): BuyInput[] {
  trackEvents(batch);
  const { caps } = state.hello;
  const tx = state.txFeeLamports();
  let free = state.freeCashLamports();
  let slots = caps.max_open_positions - state.committedPositionCount();
  const orders: BuyInput[] = [];
  const pushBuy = (mint: string, amount: bigint): boolean => {
    if (orders.length >= caps.max_orders_per_batch || free < amount + tx) return false;
    orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: MAX_SLIPPAGE_BPS });
    free -= amount + tx;
    return true;
  };
  // Pyramid add-ons first: coins already held get more only once their real
  // reserves have grown 1.5x since the last buy (the curve is still attracting
  // net buys) and the position is still under budget. An add-on never takes a
  // new position slot. Never stack two add-ons on one coin while one is still
  // in flight.
  const pendingBuy = new Set<string>();
  for (const p of state.pending.values()) {
    if (p.order.side === 'buy') pendingBuy.add(p.order.mint);
  }
  for (const [mint, position] of state.positions) {
    const track = held.get(mint);
    const curve = state.curves.get(mint);
    if (track === undefined || curve === undefined || curve.complete) continue;
    if (selling.has(mint)) continue;
    if (pendingBuy.has(mint)) continue;
    if (track.invested >= BUDGET_LAMPORTS) continue;
    if (curve.real_quote_reserves * REGROW_DEN < track.lastBuyReal * REGROW_NUM) continue;
    const cap = state.maxBuyLamports(mint);
    if (cap < MIN_BUY_LAMPORTS) continue;
    const remaining = BUDGET_LAMPORTS - track.invested;
    const amount = cap < ADD_CHUNK_LAMPORTS ? cap : ADD_CHUNK_LAMPORTS < remaining ? ADD_CHUNK_LAMPORTS : remaining;
    if (amount < MIN_BUY_LAMPORTS) continue;
    const coin = coins.get(mint);
    if (coin !== undefined) coin.lastBuyReal = curve.real_quote_reserves;
    pushBuy(mint, amount);
  }
  // First buys: only coins that traded in this batch can newly qualify, so
  // scan the batch's own events in chain order (oldest first).
  const seenThisBatch = new Set<string>();
  for (const e of batch.events) {
    if (e.event !== 'TradeEvent') continue;
    if (seenThisBatch.has(e.mint)) continue;
    seenThisBatch.add(e.mint);
    const track = coins.get(e.mint);
    if (track === undefined || track.decided) continue;
    const curve = state.curves.get(e.mint);
    if (curve === undefined || curve.complete) {
      track.decided = true;
      continue;
    }
    // Early buying pressure: a few trades, mostly buys, price up >= 5%.
    if (track.trades < ENTRY_MIN_TRADES || track.buys < ENTRY_MIN_BUYS) continue;
    const volume = track.buyVol + track.sellVol;
    if (volume <= 0n) continue;
    if (track.buyVol * ENTRY_BUY_SHARE_DEN < volume * ENTRY_BUY_SHARE_NUM) continue;
    const price = curvePrice(curve.virtual_quote_reserves, curve.virtual_token_reserves);
    if (!atLeast(price, track.p0, ENTRY_RISE_NUM, ENTRY_RISE_DEN)) continue;
    // Liquidity: the size cap must allow a buy of at least the guardrail floor.
    if (curve.real_quote_reserves < MIN_REAL_SOL) continue;
    const cap = state.maxBuyLamports(e.mint);
    if (cap < MIN_BUY_LAMPORTS) continue;
    track.decided = true;
    const amount = cap < FIRST_BUY_LAMPORTS ? cap : FIRST_BUY_LAMPORTS;
    if (slots <= 0) continue;
    track.lastBuyReal = curve.real_quote_reserves;
    if (pushBuy(e.mint, amount)) slots -= 1;
  }
  return orders;
}

function manageExits(state: BotState, batch: Batch): SellInput[] {
  const orders: SellInput[] = [];
  const { caps } = state.hello;
  for (const [mint, position] of state.positions) {
    const track = held.get(mint);
    // No entry price recorded (should not happen): hold until the harness
    // closes it rather than selling blind.
    if (track === undefined) continue;
    const curve = state.curves.get(mint);
    if (curve === undefined || curve.complete) continue;
    const price = curvePrice(curve.virtual_quote_reserves, curve.virtual_token_reserves);
    if (above(price, track.peak)) track.peak = price;
    const takeProfit = atLeast(price, track.entry, TAKE_PROFIT_NUM, TAKE_PROFIT_DEN);
    const trailedOff = atMost(price, track.peak, TRAILING_NUM, TRAILING_DEN);
    const stale = batch.slot - track.entrySlot > MAX_HOLD_SLOTS;
    if (!takeProfit && !trailedOff && !stale) continue;
    if (orders.length >= caps.max_orders_per_batch) break;
    orders.push({
      side: 'sell',
      mint,
      token_amount: position.token_amount,
      max_slippage_bps: MAX_SLIPPAGE_BPS,
    });
  }
  return orders;
}

// ------------------------------------------------------------------- loop

await runBot({
  onBatch(state, batch) {
    recordFills(batch);
    const orders: OrderInput[] = [];
    // Exits first: freeing a position slot matters more than a new entry.
    const exits = manageExits(state, batch);
    orders.push(...exits);
    const selling = new Set(exits.map((o) => o.mint));
    orders.push(...evaluateEntries(state, batch, selling));
    return orders;
  },
});
