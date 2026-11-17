// Dip-catcher for cbBTC 1-minute bars (bars-replay/v1, long only, $1,000 paper).
//
// Idea, from the dev window itself: 1-minute BTC moves are noise (std ~6 bps)
// while the round trip costs ~37 bps all-in at full size, so fast signals bleed
// fees (the EMA(8/21) baseline loses $106 on this window). The window's real
// structure is a few multi-hour swings: a -2% drawdown, then a +2.2% rally.
// This bot trades only those: it buys a dip of 1.4% off the 360-bar (6h)
// rolling high and sells the whole position at +1.1% over its cost. No stop-loss:
// testing showed a stop exits winners early on this data (it cost money on the
// mirrored window). No new entries in the last hour: a buy that late has no
// time to reach its take-profit before the forced flatten.
//
// Rules, all integer-exact (bigint, no floats, no clock, no randomness):
//   - entry: close * 10000 <= rollingHigh360 * 9860  (1.4% below the high)
//   - exit:  position value * 10000 >= cost * 10110 (1.1% over cost, fees included)
//   - size:  all cash on entry (capped by the weight room and the min notional)
//   - slippage cap 100 bps per order, so a fill past a 1% gap is refused and
//     retried on the next bar while the signal still holds.
//
// Backtest (exact local replay of the harness fill model, verified to the quote
// unit against the official grade-local on buy-and-hold, momentum and EMA-cross):
// dev window net PnL +$22.84 (3 round trips, fees $2.44, max drawdown -1.1%),
// profitable on each 12h half (+$13.14 / +$0.16), 96-97% win rate over 200
// one-hour-block bootstrap copies (median +$22-24), and positive on the
// time-reversed window (+$6.15). Worst synthetic stress is the mirrored
// (bear) window at -$2.54, far inside the 25% drawdown guardrail.
//
// Laid out like an entrant's repository: the grader runs `node /bot/main.ts`
// with this directory mounted at /bot; vendor/makefun-bars.ts is a
// byte-identical copy of bars/sdk/makefun-bars.ts.

import { runBars, type BarsState, type BuyInput, type OrderInput } from './vendor/makefun-bars.ts';

/** Bars of history for the rolling high (6 hours of 1-minute bars). */
const LOOKBACK_BARS = 360;
/** Buy when the close is this far below the rolling high, in bps (1.4%). */
const DIP_BPS = 140;
/** Sell when the position is worth this far over its cost, in bps (1.1%). */
const TAKE_PROFIT_BPS = 110;
/** Per-order slippage cap, in bps (1% past the close it was decided on). */
const MAX_SLIPPAGE_BPS = 100;
/** No new entries after this batch: the last hour has no time to reach TP. */
const NO_ENTRY_AFTER_SEQ = 1380;

const SYMBOL = 'CBBTC';

/** Closes seen so far, oldest first (the current bar's close is pushed last). */
const closes: bigint[] = [];

/** The highest close of the previous LOOKBACK_BARS bars, or null before then. */
function rollingHigh(): bigint | null {
  if (closes.length < LOOKBACK_BARS) return null;
  let high = closes[closes.length - LOOKBACK_BARS];
  for (let i = closes.length - LOOKBACK_BARS + 1; i < closes.length; i++) {
    if (closes[i] > high) high = closes[i];
  }
  return high;
}

await runBars({
  onBatch(state: BarsState, batch) {
    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (bar === undefined || state.warmingUp) {
      if (bar !== undefined) closes.push(BigInt(bar.c));
      return [];
    }
    const close = BigInt(bar.c);
    const high = rollingHigh();
    closes.push(close);

    const held = state.positions.get(SYMBOL);
    if (held !== undefined) {
      // Exit: the whole position once it is TAKE_PROFIT_BPS over its cost.
      const val = state.value(SYMBOL, held.qty, close);
      if (val * 10_000n >= held.cost * BigInt(10_000 + TAKE_PROFIT_BPS)) {
        return [{ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
      return [];
    }

    // Entry: a dip of DIP_BPS off the rolling high, never in the last hour.
    if (high === null || batch.seq >= NO_ENTRY_AFTER_SEQ) return [];
    if (close * 10_000n > high * BigInt(10_000 - DIP_BPS)) return [];
    const { caps, fees } = state.hello;
    let slice = state.cash;
    const byWeight = state.weightRoom(SYMBOL);
    if (slice > byWeight) slice = byWeight;
    if (slice === 0n || slice < BigInt(fees.min_notional_quote_units)) return [];
    const order: BuyInput = { side: 'buy', symbol: SYMBOL, notional_quote_units: slice, max_slippage_bps: MAX_SLIPPAGE_BPS };
    const orders: OrderInput[] = [order];
    return orders.slice(0, caps.max_orders_per_bar);
  },
});
