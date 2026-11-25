[![make.fun · u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/nguyenhuong74/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/nguyenhuong74/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

# Early-Rise Pyramid — Pump.fun Paper Sprint

A paper-trading bot for the make.fun competition
**"Pump.fun Paper Sprint: Any Bot Can Win"**
(`u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b`).
It trades pump.fun bonding curves on the `agent-fun/replay/v2` harness.
Paper trading only — no real funds, ever.

## Strategy

New pump.fun coins usually pump hard in their first minutes and then revert
toward their creation price — and they almost never fall far below it, so the
reversion floor, not a stop-loss, caps the downside. This bot buys only coins
that already prove early buying pressure, buys small at first, and pyramids up
only while the curve keeps attracting net buys:

**Entry** (only while the coin is young — under 5,000 slots since creation):

- at least 2 trades since creation, at least 2 of them buys;
- buy volume at least 50% of all volume so far;
- price up at least 5% from the creation price;
- at least 1 SOL of real reserves, so the harness's 1%-of-reserve size cap
  allows a buy of at least 0.01 SOL.

**Sizing — the pyramid:** the first buy is 0.01 SOL (exactly the
competition's round-trip floor). While the position is open, each time the
coin's real reserves have grown 1.5× since the last buy, the bot adds
another 0.01 SOL, up to 0.05 SOL per coin. Add-ons average the entry price
down toward the early, cheap part of the pump instead of chasing the top,
and every buy of a round trip counts toward its size under the guardrail.

**Exit** (the whole position, whichever fires first):

- take profit at +30% over the volume-weighted average entry price;
- trailing stop 30% below the best price seen since entry;
- stale exit after 20,000 slots held without an exit firing.
- No hard stop-loss: pump.fun prices revert to their creation price, they
  do not crash far through it, so a stop would only lock in the reversion.

At most 5 open positions. All prices are computed exactly from the curve's
virtual reserves (`virtual_quote_reserves / virtual_token_reserves`) with
bigint cross-multiplication — no floats, no clock, no randomness, no network.
Decisions depend only on the replay feed, so the bot is fully
deterministic: two runs produce identical action logs.

## Layout

- `main.ts` — the strategy (Node 22, runs as `node main.ts`).
- `vendor/makefun-bot.ts` — the kit's protocol shim, copied verbatim.

## License

MIT — see `LICENSE`.
