# Verdict Circuit

A claim goes in. A frozen on-chain TapeOut circuit on X Layer mainnet
returns the verdict. No trusted party, no server in the middle — anyone can
re-run the same call and get the same answer.

Built for the OKX X Layer TapeOut Accelerate ($100,000 USDT), Dec 2026.

## What it does

Prediction markets and public claims usually settle on someone's word: a
moderator, an oracle operator, a server that can be rewritten. Verdict
Circuit settles them on logic that is already frozen on-chain. You enter a
claim (a question, a threshold, an observed value); the app scales the two
numbers into the circuit's 0–65535 range, packs them into one 32-bit input,
and calls `eval()` on an existing TapeOut circuit — cpu 400 #7, a 16-bit
comparator — with a free `eth_call` on X Layer mainnet. The circuit returns
1 iff observed >= threshold (or > threshold, via the backup cpu 365 #131).
The proof card records the claim, both scaled inputs, the scale, the circuit
(cpu, #ID, processor address, gates), the block number, the output, and the
claim hash — everything needed to re-run it independently.

Optionally, the verdict is timestamped in the public VerdictLog contract on
X Layer testnet (claim hash + 0/1 only). The log never judges — it only
timestamps verdicts the mainnet circuit already computed.

## Why a real circuit matters

The verdict circuit was taped out by someone else and is immutable: we did
not write it, we cannot change it, and no server of ours stands between the
claim and the answer. That is the whole point — the trust sits in the
circuit, not in us. The app is a static page; there is no backend to
compromise, no API key to leak, no database to edit.

## Files

- `index.html` — claim form (three one-tap preset claims), proof card,
  verdict-log section, how-it-works.
- `verdict.js` — ALL chain logic (shared module). The browser imports it,
  and `verify.mjs` imports the same file in Node — one code path, two
  runtimes. Holds the `PRESETS`, input validation, `formatEvalError`, the
  keccak256 implementation, and the log reader.
- `app.js` — browser wiring only (DOM + injected wallet for the log write).
  Evaluation is one shared `runEvaluation()` used by both the button and the
  presets; a failed run clears the old proof card first, so no stale card
  can pose as the new result.
- `styles.css` — plain CSS, no framework. Mobile: 16px inputs (no iOS
  auto-zoom), 44px minimum tap targets, full-width primary button,
  proof-card table stacks to label-above-value rows under 560px.
- `verify.mjs` — verification harness (see below).

## How a verdict is computed

1. Raw threshold/observed values are scaled into the circuit's 0–65535
   range (BTC price $100/unit, ETH price $10/unit, percent 0.01%/unit,
   raw). The scale is printed on the proof card.
2. Packed as `observed | (threshold << 16)`, 4 bytes little-endian (>=
   mode). Strict > mode packs the opposite way,
   `threshold | (observed << 16)` — the proof card prints the packing each
   circuit actually uses.
3. `eval(7, input)` on processor
   `0xf9bbdc7f678eb3a49d338ffacdaad9339de50a0f` (cpu 400, circuit #7, 114
   gates) via free `eth_call` on X Layer mainnet. Output 1 iff observed >=
   threshold. Strict > uses cpu 365 #131
   (`0xf5c2bca1f38c6861f6d1303c0cbe840671ae4298`).
4. The proof card records claim, raw + scaled inputs, scale, circuit (cpu,
   #ID, processor address, gates), block number, output, claim hash
   (keccak256, verified against `cast keccak`). Anyone can re-run the same
   call and get the same output.
5. Optional: "Log this verdict" writes `(claimHash, verdict)` to VerdictLog
   `0x724cccB48e200381cC264138DA41a44Fe3AF395c` on X Layer testnet via the
   user's own injected wallet (MetaMask etc.).

## Error states

- Out-of-range scaling (e.g. BTC $7,000,000 at $100/unit = 70,000 >
  65,535), non-numeric or empty inputs, and an empty question are rejected
  before any RPC call, with a plain sentence explaining what is wrong and
  what to try.
- If both mainnet RPC endpoints are unreachable, the page says so plainly
  ("Could not reach the X Layer mainnet RPC (both endpoints tried)…")
  instead of showing a blank card. An unevaluated proof card renders
  "NOT EVALUATED", never a verdict it did not compute.

## Verify (from this directory)

```
node verify.mjs          # keccak + live evals + proof cards + factory + presets + strict-> + error paths + static + HTTP serve
node verify.mjs --log    # ... plus one testnet VerdictLog write (project wallet, cast) + log read-back
```

Day-5 result (2026-11-24): 62/62 checks with `--log`, full record in
`../data/day5-verification-20261124.json` — 5 live >= evals incl. equal and
max boundaries, 3 live preset evals, 3 live strict-> evals on the backup
circuit, 13 error-path checks, 17 static checks, 6 HTTP checks, one testnet
write (count 3 -> 4), and a log read-back confirming the fresh entry appears
in the list the page shows.

## Publish

Copy this directory to the public repo root (or a `docs/` folder) and enable
GitHub Pages. Both X Layer RPCs return `Access-Control-Allow-Origin: *`
(verified 2026-11-24), so the browser calls them directly — no proxy needed.

## Known limits (honest, not hidden)

- The testnet RPC rejects `eth_getLogs` ranges wider than 100 blocks, so
  the log section pages the most recent 10,000 blocks in 100-block chunks.
  **Decided:** 10,000 blocks is the window — testnet block time measured at
  exactly 1.000 s, so the window is ~2.8 hours. Older entries stay
  countable via `count()` and checkable one by one on the explorer; a
  full-history list would need an indexer (a server watching events), which
  is out of scope for a static page with no backend. The page says this
  plainly in the log section.
- No headless browser exists on the build VM, so the proof card was verified
  as the exact HTML string the page renders (every required field asserted
  present), not as a screenshot in a real browser — and the mobile layout
  was verified by static checks on the CSS/HTML, not by a rendered
  screenshot on a real phone. Both need the device browser before the demo
  is recorded.
- Logging needs an injected wallet on X Layer testnet; without one the
  verdict still works, only the log button is unavailable.

---

## 4. Still missing (not this unit — do not mistake this draft for done)

- Public GitHub repo + GitHub Pages publish (repo/Pages step).
- 256x256 project logo (Dec 3).
- Demo video <= 3 min, screen-only (Dec 3).
- Real-browser run + real-phone render check (device browser).
- Project X account (separate task, in progress).
- Submission itself (Dec 4, device browser, form
  https://forms.gle/EoDNbxQ65dev1wFd9).
