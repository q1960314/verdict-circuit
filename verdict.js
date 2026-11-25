// Verdict Circuit — shared core logic.
// Used by the browser app (app.js, as an ES module) AND by the Node
// verification harness (verify.mjs). One code path, two runtimes:
// the verdict flow the page runs is exactly the flow the harness tests.
// No build step, no dependencies, no secrets, no mainnet transactions.
// Reads: X Layer mainnet (196) eth_call — free. Writes: VerdictLog on
// X Layer testnet (1952) — only via the user's own injected wallet.

export const MAINNET = {
  chainId: 196,
  rpcs: ['https://rpc.xlayer.tech', 'https://xlayerrpc.okx.com'],
  factory: '0x1f09daefa827f02cbb40967cc91b259763760761',
  market: '0xd89f358c48a7B632c9845af2a02A32eB90DD75DB',
  explorer: 'https://www.okx.com/web3/explorer/xlayer',
};

export const TESTNET = {
  chainId: 1952,
  rpcs: ['https://testrpc.xlayer.tech/terigon', 'https://xlayertestrpc.okx.com/terigon'],
  verdictLog: '0x724cccB48e200381cC264138DA41a44Fe3AF395c',
  explorer: 'https://www.okx.com/web3/explorer/xlayer-test',
};

// Winner circuit (Day-2 gate, verified 20/20): cpu 400 #7, 16-bit unsigned
// comparator. Output 1 iff low 16 bits (observed) >= high 16 bits (threshold).
export const CIRCUITS = {
  ge: {
    mode: '>=',
    cpu: 400, id: 7,
    processor: '0xf9bbdc7f678eb3a49d338ffacdaad9339de50a0f',
    nIn: 32, nOut: 1, gates: 114,
    pack: (observed, threshold) => (BigInt(observed) | (BigInt(threshold) << 16n)),
    semantic: 'output 1 iff observed >= threshold',
  },
  // Backup (verified 4/4): cpu 365 #131, strict >. Observed goes high.
  gt: {
    mode: '>',
    cpu: 365, id: 131,
    processor: '0xf5c2bca1f38c6861f6d1303c0cbe840671ae4298',
    nIn: 32, nOut: 1, gates: 108,
    pack: (observed, threshold) => (BigInt(threshold) | (BigInt(observed) << 16n)),
    semantic: 'output 1 iff observed > threshold',
  },
};

export const EVAL_SELECTOR = '0x934d06ea'; // eval(uint256,bytes)
export const LOG_SELECTOR = '0x2caaebf2'; // logVerdict(bytes32,uint8)
export const COUNT_SELECTOR = '0x06661abd'; // count()

// Scale presets: every claim value is scaled into the circuit's 0-65535
// range. The scale is recorded on the proof card, so a verdict is
// re-checkable from the raw numbers alone.
export const SCALES = {
  btc100: { label: 'BTC price, $100 per unit', factor: 100, unit: '$', example: '$100,000 -> 1000' },
  eth10: { label: 'ETH price, $10 per unit', factor: 10, unit: '$', example: '$3,450 -> 345' },
  pct100: { label: 'Percentage, 0.01% per unit', factor: 0.01, unit: '%', example: '52.34% -> 5234' },
  raw: { label: 'Raw value, 0-65535 (no scaling)', factor: 1, unit: '', example: '40000 -> 40000' },
};

// One-tap example claims (Day 4): each fills the form and runs a verdict.
// expected is the live circuit output the harness asserts.
export const PRESETS = {
  btc100k: {
    label: 'BTC $100k', detail: 'BTC closed above $100,000 — equal boundary',
    question: 'BTC closed above $100,000 on Dec 1',
    thresholdRaw: '100000', observedRaw: '100000', scaleKey: 'btc100', mode: 'ge',
    expected: 1,
  },
  turnout: {
    label: 'Turnout 52.34%', detail: 'Voter turnout exceeded 50.00% — percent scale',
    question: 'Voter turnout exceeded 50.00%',
    thresholdRaw: '50.00', observedRaw: '52.34', scaleKey: 'pct100', mode: 'ge',
    expected: 1,
  },
  raw39999: {
    label: 'Raw 39,999 vs 40,000', detail: 'A raw counter reached 40,000 — just below, FALSE',
    question: 'A raw counter reached 40,000',
    thresholdRaw: '40000', observedRaw: '39999', scaleKey: 'raw', mode: 'ge',
    expected: 0,
  },
};

export function scaleValue(raw, scaleKey) {
  const s = SCALES[scaleKey];
  if (!s) throw new Error('unknown scale: ' + scaleKey);
  const n = Number(raw);
  if (raw === '' || raw === null || raw === undefined || !Number.isFinite(n)) {
    throw new Error(`"${raw}" is not a number — enter a numeric value.`);
  }
  const scaled = Math.round(n / s.factor);
  if (scaled < 0 || scaled > 65535) {
    const dir = scaled > 65535 ? 'too large' : 'too small (negative)';
    throw new Error(`Value ${raw} is ${dir} for the circuit: at ${s.label} it becomes ${scaled}, but the circuit only accepts 0–65535. Try a smaller value or a coarser scale.`);
  }
  return scaled;
}

// ---- minimal JSON-RPC client (fetch, primary + fallback) ----
let rpcSeq = 0;
export async function rpc(rpcs, method, params) {
  let lastErr;
  for (const url of rpcs) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcSeq, method, params }),
        signal: AbortSignal.timeout(20000),
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      if (j.error) throw new Error(j.error.message || 'RPC error');
      return j.result;
    } catch (e) { lastErr = e; }
  }
  throw new Error('RPC failed on all endpoints: ' + (lastErr && lastErr.message || 'unknown'));
}

// Plain, specific error text for the page. Input problems (bad number,
// out-of-range scaling, empty question) are reported as-is — they are
// already written in plain language. RPC failures get a plain prefix plus
// the underlying detail, so the page never shows a bare code or a blank card.
export function formatEvalError(e) {
  const msg = (e && e.message) || String(e);
  if (/RPC failed on all endpoints/i.test(msg)) {
    return 'Could not reach the X Layer mainnet RPC (both endpoints tried). Check your connection and try again. ' + msg;
  }
  return msg;
}
const u256 = (n) => BigInt(n).toString(16).padStart(64, '0');
function leBytes(value, nBytes) {
  const buf = new Uint8Array(nBytes);
  let v = BigInt(value);
  for (let i = 0; i < nBytes; i++) { buf[i] = Number(v & 0xffn); v >>= 8n; }
  return buf;
}
function hexOf(bytes) { return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join(''); }

export function encodeEvalCall(circuitId, inputBytes) {
  const data = new Uint8Array(inputBytes);
  const padded = new Uint8Array(Math.ceil(data.length / 32) * 32);
  padded.set(data);
  return EVAL_SELECTOR + u256(circuitId) + u256(64) + u256(data.length) + hexOf(padded);
}

export function decodeBytesReturn(hex) {
  const w = (i) => BigInt('0x' + hex.slice(2 + i * 64, 2 + (i + 1) * 64));
  const offset = Number(w(0));
  const li = offset / 32;
  const len = Number(w(li));
  const dataStart = 2 + (li + 1) * 64;
  return '0x' + hex.slice(dataStart, dataStart + len * 2);
}

// One live mainnet eval. Returns { output (0|1), blockNumber }.
export async function evalCircuit(circuit, observedScaled, thresholdScaled) {
  const value = circuit.pack(observedScaled, thresholdScaled);
  const data = encodeEvalCall(circuit.id, leBytes(value, 4));
  const blockHex = await rpc(MAINNET.rpcs, 'eth_blockNumber', []);
  const ret = await rpc(MAINNET.rpcs, 'eth_call', [{ to: circuit.processor, data }, 'latest']);
  const outHex = decodeBytesReturn(ret);
  const output = Number(BigInt(outHex) & 1n);
  if (output !== 0 && output !== 1) throw new Error('unexpected circuit output: ' + outHex);
  return { output, blockNumber: Number(BigInt(blockHex)) };
}

export async function factoryCpuCount() {
  // cpuCount() selector a94da8a7
  const ret = await rpc(MAINNET.rpcs, 'eth_call', [{ to: MAINNET.factory, data: '0xa94da8a7' }, 'latest']);
  return Number(BigInt(ret));
}

// ---- keccak256 (Keccak-f1600, BigInt lanes). Verified against `cast keccak`. ----
const MASK64 = (1n << 64n) - 1n;
const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
const PILN = [10, 7, 11, 17, 18, 3, 5, 16, 8, 21, 24, 4, 15, 23, 19, 13, 12, 2, 20, 14, 22, 9, 6, 1];
const ROTC = [1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 2, 14, 27, 41, 56, 8, 25, 43, 62, 18, 39, 61, 20, 44];
const rotl64 = (x, n) => n === 0 ? x : ((x << BigInt(n)) | (x >> BigInt(64 - n))) & MASK64;

function keccakF1600(s) {
  for (let round = 0; round < 24; round++) {
    const C = [];
    for (let x = 0; x < 5; x++) C[x] = s[x] ^ s[x + 5] ^ s[x + 10] ^ s[x + 15] ^ s[x + 20];
    for (let x = 0; x < 5; x++) {
      const d = C[(x + 4) % 5] ^ rotl64(C[(x + 1) % 5], 1);
      for (let y = 0; y < 5; y++) s[x + 5 * y] ^= d;
    }
    let t = s[1];
    for (let i = 0; i < 24; i++) {
      const j = PILN[i];
      const tmp = s[j];
      s[j] = rotl64(t, ROTC[i]);
      t = tmp;
    }
    for (let y = 0; y < 5; y++) {
      const row = [s[5 * y], s[5 * y + 1], s[5 * y + 2], s[5 * y + 3], s[5 * y + 4]];
      for (let x = 0; x < 5; x++) s[5 * y + x] = row[x] ^ (~row[(x + 1) % 5] & row[(x + 2) % 5]);
    }
    s[0] ^= RC[round];
  }
}

export function keccak256(inputBytes) {
  const msg = inputBytes instanceof Uint8Array ? inputBytes : new TextEncoder().encode(inputBytes);
  const rate = 136;
  const s = new Array(25).fill(0n);
  for (let off = 0; off < msg.length; off += rate) {
    const block = msg.slice(off, off + rate);
    for (let i = 0; i < block.length; i++) {
      const lane = Math.floor(i / 8);
      s[lane] ^= BigInt(block[i]) << BigInt(8 * (i % 8));
    }
    if (block.length === rate) keccakF1600(s);
  }
  // pad10*1, suffix 0x01
  const lastLen = msg.length % rate;
  const pad = new Uint8Array(rate);
  pad[lastLen] = 0x01;
  pad[rate - 1] |= 0x80;
  for (let i = lastLen; i < rate; i++) {
    const lane = Math.floor(i / 8);
    s[lane] ^= BigInt(pad[i]) << BigInt(8 * (i % 8));
  }
  keccakF1600(s);
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    const lane = Math.floor(i / 8);
    out[i] = Number((s[lane] >> BigInt(8 * (i % 8))) & 0xffn);
  }
  return '0x' + hexOf(out);
}

export function claimHash(claimText) {
  return keccak256(new TextEncoder().encode(claimText));
}

// ---- VerdictLog (testnet) ----
export function encodeLogVerdictCall(claimHashHex, verdict) {
  if (verdict !== 0 && verdict !== 1) throw new Error('verdict must be 0 or 1');
  return LOG_SELECTOR + claimHashHex.slice(2).padStart(64, '0') + u256(verdict);
}
export async function verdictLogCount() {
  const ret = await rpc(TESTNET.rpcs, 'eth_call', [{ to: TESTNET.verdictLog, data: COUNT_SELECTOR }, 'latest']);
  return Number(BigInt(ret));
}
// Log window, decided Day 5 (2026-11-24, measured, not assumed):
// X Layer testnet block time is 1.000 s (last 1,000 blocks, tip 47049506),
// so 10,000 blocks = 2.78 h (~3 h). The testnet RPC rejects eth_getLogs
// ranges wider than 100 blocks, and paging the window takes ~9 s, so a
// wider window would slow the page linearly. Older entries stay countable
// via count() and checkable one by one on the explorer. A full-history list
// would need an indexer (a server watching events) — out of scope for a
// static page with no backend. The section header says "recent" and the
// page copy states this plainly.
export const LOG_WINDOW_BLOCKS = 10000;

export async function verdictLogEntries(windowBlocks = LOG_WINDOW_BLOCKS) {
  // The testnet RPC rejects eth_getLogs ranges wider than 100 blocks
  // ("block range greater than 100 max"), so page the recent window in
  // 100-block chunks, 10 concurrent at a time. Older entries stay
  // countable via count(); the section shows the recent window only.
  const topic0 = keccak256(new TextEncoder().encode('VerdictLogged(uint256,bytes32,uint8,uint256)'));
  const tip = Number(BigInt(await rpc(TESTNET.rpcs, 'eth_blockNumber', [])));
  const from = Math.max(0, tip - windowBlocks);
  const ranges = [];
  for (let start = from; start <= tip; start += 100) {
    ranges.push([start, Math.min(start + 99, tip)]);
  }
  const chunks = [];
  for (let i = 0; i < ranges.length; i += 10) {
    chunks.push(...(await Promise.all(ranges.slice(i, i + 10).map(([a, b]) =>
      rpc(TESTNET.rpcs, 'eth_getLogs', [{
        address: TESTNET.verdictLog,
        fromBlock: '0x' + a.toString(16), toBlock: '0x' + b.toString(16), topics: [topic0],
      }])))));
  }
  const logs = chunks.flat();
  return logs.map((l) => ({
    id: Number(BigInt('0x' + l.topics[1].slice(2))),
    claimHash: l.topics[2],
    verdict: Number(BigInt(l.data.slice(0, 66))),
    blockNumber: Number(BigInt(l.blockNumber)),
    txHash: l.transactionHash,
  })).sort((a, b) => a.id - b.id);
}

// ---- proof card ----
export function buildProof(claim) {
  // claim: { question, thresholdRaw, observedRaw, scaleKey, mode }
  // Validation lives here (shared by the page and the harness), so the
  // page can never silently evaluate an empty or non-numeric input:
  // Number('') is 0, so emptiness must be rejected explicitly.
  if (!claim.question || !String(claim.question).trim()) {
    throw new Error('Enter a question for the claim.');
  }
  if (claim.thresholdRaw === '' || claim.thresholdRaw === null || claim.thresholdRaw === undefined) {
    throw new Error('Enter a number for the threshold.');
  }
  if (claim.observedRaw === '' || claim.observedRaw === null || claim.observedRaw === undefined) {
    throw new Error('Enter a number for the observed value.');
  }
  const circuit = CIRCUITS[claim.mode];
  if (!circuit) throw new Error('unknown comparison mode: ' + claim.mode);
  const thresholdScaled = scaleValue(claim.thresholdRaw, claim.scaleKey);
  const observedScaled = scaleValue(claim.observedRaw, claim.scaleKey);
  return {
    question: claim.question,
    mode: circuit.mode,
    thresholdRaw: claim.thresholdRaw,
    observedRaw: claim.observedRaw,
    thresholdScaled, observedScaled,
    scale: SCALES[claim.scaleKey].label,
    scaleKey: claim.scaleKey,
    circuit: { cpu: circuit.cpu, id: circuit.id, processor: circuit.processor, gates: circuit.gates, semantic: circuit.semantic },
    // The exact input packing for the re-run line. The two circuits pack
    // opposite ways (>= : observed low / threshold high; strict > :
    // observed high / threshold low) — the card must print the packing
    // this circuit actually uses, or the re-run line is a wrong answer.
    packExpr: circuit.mode === '>'
      ? `${thresholdScaled} | (${observedScaled} << 16)`
      : `${observedScaled} | (${thresholdScaled} << 16)`,
    claimHash: claimHash(claim.question + '|' + claim.thresholdRaw + '|' + claim.observedRaw + '|' + claim.scaleKey + '|' + circuit.mode),
    output: null, blockNumber: null, verdict: null, evaluatedAt: null,
  };
}

export function renderProofCard(p) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const verdictText = p.output === null ? 'NOT EVALUATED' : (p.output === 1 ? 'TRUE' : 'FALSE');
  const verdictClass = p.output === null ? '' : (p.output === 1 ? 'verdict-true' : 'verdict-false');
  const rows = [
    ['Claim', esc(p.question)],
    ['Mode', `${esc(p.mode)} &nbsp;(${esc(p.circuit.semantic)})`],
    ['Threshold', `${esc(p.thresholdRaw)} &rarr; scaled <b>${p.thresholdScaled}</b>`],
    ['Observed', `${esc(p.observedRaw)} &rarr; scaled <b>${p.observedScaled}</b>`],
    ['Scale', esc(p.scale)],
    ['Circuit', `cpu ${p.circuit.cpu} #${p.circuit.id} &middot; ${p.circuit.gates} gates`],
    ['Processor', `<code>${esc(p.circuit.processor)}</code>`],
    ['Claim hash', `<code>${esc(p.claimHash)}</code>`],
    ['Block', p.blockNumber === null ? '&mdash;' : String(p.blockNumber)],
    ['Circuit output', p.output === null ? '&mdash;' : String(p.output)],
    ['Evaluated at', p.evaluatedAt === null ? '&mdash;' : esc(p.evaluatedAt)],
  ];
  return `<div class="proof-card">
    <div class="proof-verdict ${verdictClass}">${verdictText}</div>
    <table>${rows.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join('')}</table>
    <p class="proof-rerun">Re-run it: <code>eval(${p.circuit.id}, ${esc(p.packExpr)})</code>
    on <code>${esc(p.circuit.processor)}</code> via any X Layer mainnet RPC — the same call returns the same output.</p>
  </div>`;
}
