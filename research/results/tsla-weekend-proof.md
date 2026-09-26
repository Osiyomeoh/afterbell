# Hyperliquid's closed-hours TSLA price vs the next Pyth open

Generated 2026-09-26T00:18:53.690Z by `npm run proof`.
Opens and closes: Pyth Equity.US.TSLA/USD: first print at or after 16:00 ET (close) and 09:30 ET (open). Candidate: last traded price of Hyperliquid's xyz:TSLA perpetual at each checkpoint.
Errors are mean absolute distance from Pyth's opening print, in basis points (100 bps = 1%).

| Checkpoint | All openings | Weekends | Weeknights | Direction right on gaps > 25 bps |
|---|---|---|---|---|
| Saturday 09:30 ET (weekends only) | n=9 | HL 77 bps vs close 72 bps | closer 44% | error removed -6% | n=9 | HL 77 bps vs close 72 bps | closer 44% | error removed -6% | n/a | 57% of 7 |
| 24h before the open | n=9 | HL 96 bps vs close 72 bps | closer 22% | error removed -32% | n=9 | HL 96 bps vs close 72 bps | closer 22% | error removed -32% | n/a | 29% of 7 |
| 12h before the open (21:30 ET) | n=46 | HL 97 bps vs close 114 bps | closer 57% | error removed 15% | n=9 | HL 74 bps vs close 72 bps | closer 44% | error removed -2% | n=37 | HL 102 bps vs close 124 bps | closer 59% | error removed 18% | 70% of 37 |
| 04:00 ET, pre-market starts | n=46 | HL 86 bps vs close 114 bps | closer 63% | error removed 24% | n=9 | HL 78 bps vs close 72 bps | closer 44% | error removed -8% | n=37 | HL 88 bps vs close 124 bps | closer 68% | error removed 29% | 84% of 37 |
| 09:00 ET | n=46 | HL 43 bps vs close 114 bps | closer 78% | error removed 62% | n=9 | HL 46 bps vs close 72 bps | closer 67% | error removed 37% | n=37 | HL 43 bps vs close 124 bps | closer 81% | error removed 66% | 97% of 37 |
| 09:30 ET, at the open | n=37 | HL 4 bps vs close 104 bps | closer 100% | error removed 97% | n=7 | HL 4 bps vs close 90 bps | closer 100% | error removed 96% | n=30 | HL 3 bps vs close 108 bps | closer 100% | error removed 97% | 100% of 31 |

At the open (09:30 ET), Hyperliquid's price was a median 3.4 bps from Pyth's opening print: that is the basis a hedge closed at the open would carry.
