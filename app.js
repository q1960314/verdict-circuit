// Verdict Circuit — browser wiring. All chain logic lives in verdict.js
// (the same module verify.mjs tests in Node); this file only wires the DOM.
import {
  MAINNET, TESTNET, CIRCUITS, SCALES, PRESETS,
  evalCircuit, factoryCpuCount, buildProof, renderProofCard, formatEvalError,
  encodeLogVerdictCall, verdictLogCount, verdictLogEntries,
} from './verdict.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let currentProof = null;

// Scale selector
const scaleSel = $('scale');
for (const [key, s] of Object.entries(SCALES)) {
  const opt = document.createElement('option');
  opt.value = key;
  opt.textContent = `${s.label} (e.g. ${s.example})`;
  scaleSel.appendChild(opt);
}
scaleSel.value = 'btc100';
const updateScaleHint = () => { $('scaleHint').textContent = 'Example: ' + SCALES[scaleSel.value].example; };
scaleSel.addEventListener('change', updateScaleHint);
updateScaleHint();

// Live factory status (Day-3 milestone: the page reads mainnet on load)
(async () => {
  try {
    const [count, blockHex] = await Promise.all([
      factoryCpuCount(),
      fetch(MAINNET.rpcs[0], {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
      }).then((r) => r.json()).then((j) => j.result),
    ]);
    $('chainStatus').textContent =
      `X Layer mainnet (chain 196) · TapeOut factory: ${count} CPUs · block ${Number(BigInt(blockHex))} · live`;
  } catch (e) {
    $('chainStatus').textContent = 'Could not reach X Layer mainnet RPC: ' + e.message;
  }
})();

// Verdict log (testnet) — read-only, no wallet needed
$('logAddr').textContent = TESTNET.verdictLog;
async function refreshLog() {
  try {
    const [count, entries] = await Promise.all([verdictLogCount(), verdictLogEntries()]);
    $('logCount').textContent = `${count} verdict(s) logged.`;
    const box = $('logEntries');
    if (!entries.length) { box.innerHTML = '<p class="note">No verdicts logged yet.</p>'; return; }
    box.innerHTML = entries.slice(-10).reverse().map((e) =>
      `<div class="log-entry">#${e.id} · verdict <b>${e.verdict === 1 ? 'TRUE' : 'FALSE'}</b> · block ${e.blockNumber}<br>
       <code>${esc(e.claimHash)}</code><br>
       <a href="${TESTNET.explorer}/tx/${esc(e.txHash)}" target="_blank" rel="noopener">tx ${esc(e.txHash.slice(0, 18))}…</a></div>`
    ).join('');
  } catch (e) {
    $('logEntries').innerHTML = `<p class="error">Could not read the verdict log: ${esc(e.message)}</p>`;
  }
}
refreshLog();

// Evaluate — shared by the "Ask the circuit" button and the one-tap presets.
// The old proof card is cleared first, so a failed run can never leave a
// stale card on screen looking like the new result.
async function runEvaluation() {
  const err = $('evalError');
  err.hidden = true;
  $('resultSection').hidden = true;
  $('proofCard').innerHTML = '';
  const btn = $('evaluateBtn');
  btn.disabled = true;
  btn.textContent = 'Asking the circuit…';
  try {
    const claim = {
      question: $('question').value.trim(),
      thresholdRaw: $('threshold').value,
      observedRaw: $('observed').value,
      scaleKey: scaleSel.value,
      mode: $('mode').value,
    };
    const proof = buildProof(claim);
    const { output, blockNumber } = await evalCircuit(CIRCUITS[claim.mode], proof.observedScaled, proof.thresholdScaled);
    proof.output = output;
    proof.blockNumber = blockNumber;
    proof.verdict = output === 1;
    proof.evaluatedAt = new Date().toISOString();
    currentProof = proof;
    $('proofCard').innerHTML = renderProofCard(proof);
    $('resultSection').hidden = false;
    $('logSuccess').hidden = true;
    $('logError').hidden = true;
    $('resultSection').scrollIntoView({ behavior: 'smooth' });
  } catch (e) {
    // No silent blank card: the error line always carries a plain,
    // specific message (input problem or RPC failure, see formatEvalError).
    currentProof = null;
    err.textContent = 'Could not get a verdict: ' + formatEvalError(e);
    err.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Ask the circuit';
  }
}

$('evaluateBtn').addEventListener('click', runEvaluation);

// One-tap presets: fill the form from PRESETS and run the same flow.
document.querySelectorAll('.preset-btn').forEach((b) => {
  b.addEventListener('click', () => {
    const p = PRESETS[b.dataset.preset];
    if (!p) return;
    $('question').value = p.question;
    $('threshold').value = p.thresholdRaw;
    $('observed').value = p.observedRaw;
    scaleSel.value = p.scaleKey;
    updateScaleHint();
    $('mode').value = p.mode;
    runEvaluation();
  });
});

// Log on testnet (user's own wallet, injected provider only)
$('logBtn').addEventListener('click', async () => {
  const err = $('logError');
  const ok = $('logSuccess');
  err.hidden = true; ok.hidden = true;
  if (!currentProof) return;
  const btn = $('logBtn');
  btn.disabled = true;
  btn.textContent = 'Logging…';
  try {
    if (!window.ethereum) throw new Error('No wallet detected in this browser. Install MetaMask (or similar), connect it to X Layer testnet (chain 1952), and try again. The verdict above is valid whether or not it is logged.');
    const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
    const from = accounts[0];
    const chainId = await window.ethereum.request({ method: 'eth_chainId' });
    if (Number(BigInt(chainId)) !== TESTNET.chainId) {
      try {
        await window.ethereum.request({
          method: 'wallet_switchEthereumChain',
          params: [{ chainId: '0x' + TESTNET.chainId.toString(16) }],
        });
      } catch (switchErr) {
        if (switchErr.code === 4902) {
          await window.ethereum.request({
            method: 'wallet_addEthereumChain',
            params: [{
              chainId: '0x' + TESTNET.chainId.toString(16),
              chainName: 'X Layer Testnet',
              nativeCurrency: { name: 'OKB', symbol: 'OKB', decimals: 18 },
              rpcUrls: TESTNET.rpcs,
              blockExplorerUrls: [TESTNET.explorer],
            }],
          });
        } else throw new Error('Please switch your wallet to X Layer testnet (chain 1952).');
      }
    }
    const data = encodeLogVerdictCall(currentProof.claimHash, currentProof.output);
    const txHash = await window.ethereum.request({
      method: 'eth_sendTransaction',
      params: [{ from, to: TESTNET.verdictLog, data }],
    });
    ok.innerHTML = `Logged. tx <a href="${TESTNET.explorer}/tx/${esc(txHash)}" target="_blank" rel="noopener">${esc(txHash)}</a> — the log refreshes below once it confirms.`;
    ok.hidden = false;
    setTimeout(refreshLog, 5000);
  } catch (e) {
    err.textContent = 'Logging failed: ' + (e.message || e);
    err.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Log this verdict on X Layer testnet';
  }
});
