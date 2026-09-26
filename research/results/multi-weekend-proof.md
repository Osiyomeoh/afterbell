# Hyperliquid's closed-hours price vs the next open, six xyz markets

Generated 2026-09-26T00:19:46.532Z by `npx tsx research/proof-multi.ts`.
Close and open are Hyperliquid's own last trade at 16:00 ET and 09:30 ET (30-minute candles).
Checked against Pyth on TSLA: Hyperliquid at 16:00 ET is a median 2.7 bps from Pyth's close (n=46), at 09:30 ET 4.1 bps from Pyth's open (n=46).

| Market | Hours before the open | Weekends: n, HL vs close error (bps), HL closer, error removed | Weeknights: same |
|---|---|---|---|
| xyz:TSLA | 48 | 14, 86 vs 83, 50%, -3% | n/a |
| xyz:TSLA | 24 | 14, 93 vs 83, 43%, -13% | n/a |
| xyz:TSLA | 12 | 14, 58 vs 83, 64%, 30% | 57, 94 vs 114, 68%, 18% |
| xyz:TSLA | 5.5 | 14, 68 vs 83, 64%, 18% | 57, 82 vs 114, 65%, 29% |
| xyz:NVDA | 48 | 14, 90 vs 92, 50%, 3% | n/a |
| xyz:NVDA | 24 | 14, 90 vs 92, 50%, 2% | n/a |
| xyz:NVDA | 12 | 14, 73 vs 92, 57%, 21% | 57, 80 vs 117, 70%, 32% |
| xyz:NVDA | 5.5 | 14, 65 vs 92, 71%, 29% | 57, 60 vs 117, 79%, 49% |
| xyz:AAPL | 48 | 14, 70 vs 59, 36%, -19% | n/a |
| xyz:AAPL | 24 | 14, 71 vs 59, 36%, -19% | n/a |
| xyz:AAPL | 12 | 14, 62 vs 59, 43%, -5% | 57, 50 vs 62, 56%, 19% |
| xyz:AAPL | 5.5 | 14, 54 vs 59, 71%, 9% | 57, 46 vs 62, 56%, 26% |
| xyz:COIN | 48 | 14, 193 vs 172, 29%, -13% | n/a |
| xyz:COIN | 24 | 14, 235 vs 172, 29%, -37% | n/a |
| xyz:COIN | 12 | 14, 194 vs 172, 43%, -13% | 57, 181 vs 216, 68%, 16% |
| xyz:COIN | 5.5 | 14, 135 vs 172, 57%, 21% | 57, 148 vs 216, 67%, 32% |
| xyz:MSTR | 48 | 14, 275 vs 256, 50%, -7% | n/a |
| xyz:MSTR | 24 | 14, 296 vs 256, 36%, -15% | n/a |
| xyz:MSTR | 12 | 14, 279 vs 256, 50%, -9% | 57, 210 vs 242, 60%, 13% |
| xyz:MSTR | 5.5 | 14, 202 vs 256, 71%, 21% | 57, 173 vs 242, 67%, 28% |
| xyz:XYZ100 | 48 | 14, 66 vs 69, 43%, 4% | n/a |
| xyz:XYZ100 | 24 | 14, 56 vs 69, 43%, 19% | n/a |
| xyz:XYZ100 | 12 | 14, 38 vs 69, 64%, 45% | 57, 60 vs 78, 68%, 23% |
| xyz:XYZ100 | 5.5 | 14, 26 vs 69, 64%, 62% | 57, 36 vs 78, 82%, 54% |

## Pooled across the six markets

| Hours before the open | Weekends | Weeknights |
|---|---|---|
| 48 | n=84: HL 130 bps vs close 122 bps, HL closer 43%, error removed -7% | n/a |
| 24 | n=84: HL 140 bps vs close 122 bps, HL closer 39%, error removed -15% | n/a |
| 12 | n=84: HL 117 bps vs close 122 bps, HL closer 54%, error removed 4% | n=342: HL 113 bps vs close 138 bps, HL closer 65%, error removed 19% |
| 5.5 | n=84: HL 92 bps vs close 122 bps, HL closer 67%, error removed 25% | n=342: HL 91 bps vs close 138 bps, HL closer 69%, error removed 34% |
