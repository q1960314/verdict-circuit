// Day-5 verification harness. Runs the app code path (verdict.js, the same
// module the browser imports) end to end against LIVE chains:
//  - keccak256 vs cast-derived vectors
//  - live mainnet eval on 5 claims incl. equal-boundary + max-boundary
//  - proof-card render assertions (every required field present)
//  - live factory cpuCount read
//  - one testnet VerdictLog write via cast + receipt + count() increment
//  - (Day 5) strict-> live evals on the backup circuit cpu 365 #131,
//    proof-card packing assertions (the two circuits pack opposite ways),
//    log-window copy checks, and a log-section read-back after the fresh
//    testnet write (the new entry must appear in verdictLogEntries()).
// Usage: node verify.mjs [--log]   (--log performs the one testnet write)
import fs from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import {
  MAINNET, TESTNET, CIRCUITS, SCALES, PRESETS, LOG_WINDOW_BLOCKS,
  evalCircuit, factoryCpuCount, buildProof, renderProofCard, formatEvalError,
  scaleValue, rpc,
  keccak256, claimHash, encodeLogVerdictCall, verdictLogCount, verdictLogEntries,
} from './verdict.js';

const DO_LOG = process.argv.includes('--log');
const results = { generatedAt: new Date().toISOString(), keccak: [], claims: [], factory: null, proofCards: [], presets: [], strictGt: [], errors: [], staticChecks: [], http: [], testnet: null, logReadback: null };
let failures = 0;
let total = 0;
const check = (name, ok, detail) => {
  total++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
};
// Assert a function throws an error matching a pattern; returns the message.
const expectThrow = (name, fn, pattern) => {
  let msg = null;
  try { fn(); } catch (e) { msg = e.message; }
  const ok = msg !== null && pattern.test(msg);
  results.errors.push({ name, message: msg, pass: ok });
  check(name, ok, msg === null ? 'did NOT throw' : msg);
  return msg;
};

// 1. keccak256 vs cast-derived vectors (cast keccak, 2026-11-24)
for (const [input, expected] of [
  ['', '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470'],
  ['hello', '0x1c8aff950685c2ed4bc3174f3472287b56d9517b9c948127319a09a7a36deac8'],
  ['verdict-test', '0x6b8d18a5787947d2eb4ef0ff7bb6db8984f3a37d7e0ccc1eec79f3446858dbfa'],
  ['BTC closed above $100,000 on Dec 1', '0x09ea00d6729c78db8c197b24b03885356cbaa618b41b3a6d6d8a1bf89d22bcfc'],
]) {
  const got = keccak256(new TextEncoder().encode(input));
  const ok = got === expected;
  results.keccak.push({ input, expected, got, pass: ok });
  check(`keccak256(${JSON.stringify(input)})`, ok, got);
}

// 2. Live factory read
const cpuCount = await factoryCpuCount();
results.factory = { cpuCount };
check('factory cpuCount live read', cpuCount === 444, `cpuCount=${cpuCount}`);

// 3. Live mainnet evals — 5 claims, incl. equal-boundary (A, D) and max (E)
const claims = [
  { name: 'A', question: 'BTC closed above $100,000 on Dec 1', thresholdRaw: '100000', observedRaw: '100000', scaleKey: 'btc100', mode: 'ge', expected: 1, note: 'equal boundary (1000 vs 1000)' },
  { name: 'B', question: 'BTC closed above $100,000 on Dec 1', thresholdRaw: '100000', observedRaw: '98500', scaleKey: 'btc100', mode: 'ge', expected: 0, note: 'below (985 vs 1000)' },
  { name: 'C', question: 'Voter turnout exceeded 50.00%', thresholdRaw: '50.00', observedRaw: '52.34', scaleKey: 'pct100', mode: 'ge', expected: 1, note: 'percent scale (5234 vs 5000)' },
  { name: 'D', question: 'Raw zero-boundary check', thresholdRaw: '0', observedRaw: '0', scaleKey: 'raw', mode: 'ge', expected: 1, note: 'equal boundary (0 vs 0)' },
  { name: 'E', question: 'Raw max-boundary check', thresholdRaw: '65534', observedRaw: '65535', scaleKey: 'raw', mode: 'ge', expected: 1, note: 'max boundary (65535 vs 65534)' },
];
for (const c of claims) {
  const proof = buildProof(c);
  const { output, blockNumber } = await evalCircuit(CIRCUITS[c.mode], proof.observedScaled, proof.thresholdScaled);
  proof.output = output;
  proof.blockNumber = blockNumber;
  proof.verdict = output === 1;
  proof.evaluatedAt = new Date().toISOString();
  const ok = output === c.expected;
  results.claims.push({ ...c, thresholdScaled: proof.thresholdScaled, observedScaled: proof.observedScaled, output, blockNumber, claimHash: proof.claimHash, pass: ok });
  check(`claim ${c.name} eval (${c.note})`, ok, `scaled ${proof.observedScaled} vs ${proof.thresholdScaled} -> output ${output} (expected ${c.expected}), block ${blockNumber}`);

  // 4. Proof-card render assertions
  const html = renderProofCard(proof);
  const required = [
    c.question, String(proof.observedScaled), String(proof.thresholdScaled),
    SCALES[c.scaleKey].label, `cpu ${proof.circuit.cpu} #${proof.circuit.id}`,
    proof.circuit.processor, proof.claimHash, String(blockNumber), String(output),
    output === 1 ? 'TRUE' : 'FALSE',
  ];
  const missing = required.filter((s) => !html.includes(s));
  results.proofCards.push({ claim: c.name, missing, pass: missing.length === 0 });
  check(`claim ${c.name} proof card renders all fields`, missing.length === 0, missing.length ? 'missing: ' + missing.join(', ') : `${html.length} chars`);
}

// 5. Presets (Day 4): each one-tap example builds + live-evals to its
// expected output through the same code path the page runs.
for (const [key, p] of Object.entries(PRESETS)) {
  const proof = buildProof(p);
  const { output, blockNumber } = await evalCircuit(CIRCUITS[p.mode], proof.observedScaled, proof.thresholdScaled);
  const ok = output === p.expected;
  results.presets.push({ key, label: p.label, thresholdScaled: proof.thresholdScaled, observedScaled: proof.observedScaled, output, expected: p.expected, blockNumber, pass: ok });
  check(`preset ${key} (${p.label}) live eval`, ok, `scaled ${proof.observedScaled} vs ${proof.thresholdScaled} -> ${output} (expected ${p.expected}), block ${blockNumber}`);
}

// 5b. Strict > (Day 5): live evals through the backup circuit cpu 365
// #131, via the same evalCircuit code path the page runs when the user
// picks ">" — the packing is opposite (>= : observed low; strict > :
// observed high), so the equal boundary must flip from 1 to 0.
const gtClaims = [
  { name: 'F', question: 'A raw counter passed 40,000', thresholdRaw: '40000', observedRaw: '40001', scaleKey: 'raw', mode: 'gt', expected: 1, note: 'strictly greater (40001 > 40000), backup cpu 365 #131' },
  { name: 'G', question: 'A raw counter passed 40,000', thresholdRaw: '40000', observedRaw: '40000', scaleKey: 'raw', mode: 'gt', expected: 0, note: 'equal boundary under strict > (40000 vs 40000) — must be 0' },
  { name: 'H', question: 'A raw counter passed 40,000', thresholdRaw: '40000', observedRaw: '39999', scaleKey: 'raw', mode: 'gt', expected: 0, note: 'below (39999 vs 40000)' },
];
for (const c of gtClaims) {
  const proof = buildProof(c);
  const { output, blockNumber } = await evalCircuit(CIRCUITS[c.mode], proof.observedScaled, proof.thresholdScaled);
  const ok = output === c.expected;
  results.strictGt.push({ ...c, thresholdScaled: proof.thresholdScaled, observedScaled: proof.observedScaled, packExpr: proof.packExpr, output, blockNumber, claimHash: proof.claimHash, pass: ok });
  check(`strict > claim ${c.name} eval (${c.note})`, ok, `packed ${proof.packExpr} -> output ${output} (expected ${c.expected}), block ${blockNumber}`);
}
// Proof-card packing: the re-run line must print the packing the circuit
// actually uses. Before Day 5 it hardcoded observed-low for both modes,
// which is wrong for strict >.
{
  const cardA = renderProofCard(buildProof(claims[0]));
  const okA = cardA.includes('eval(7, 1000 | (1000 &lt;&lt; 16))');
  results.strictGt.push({ name: 'proof card A re-run line packs observed low (ge)', packExpr: '1000 | (1000 << 16)', pass: okA });
  check('proof card A re-run line packs observed low (ge)', okA, 'eval(7, 1000 | (1000 << 16))');
  const proofF = buildProof(gtClaims[0]);
  const cardF = renderProofCard(proofF);
  const okF = cardF.includes('eval(131, 40000 | (40001 &lt;&lt; 16))')
    && !cardF.includes('eval(131, 40001 | (40000 &lt;&lt; 16))')
    && cardF.includes('cpu 365 #131')
    && cardF.includes(CIRCUITS.gt.processor);
  results.strictGt.push({ name: 'proof card F re-run line packs observed high (gt)', packExpr: proofF.packExpr, pass: okF });
  check('proof card F re-run line packs observed high (gt)', okF, `eval(131, ${proofF.packExpr}); cpu 365 #131 + processor present, wrong-order packing absent`);
  const okPackObj = proofF.packExpr === '40000 | (40001 << 16)' && buildProof(claims[0]).packExpr === '1000 | (1000 << 16)';
  results.strictGt.push({ name: 'buildProof packExpr matches each circuit', pass: okPackObj });
  check('buildProof packExpr matches each circuit', okPackObj, `ge: 1000 | (1000 << 16); gt: 40000 | (40001 << 16)`);
}

// 6. Error paths (Day 4): out-of-range scaling, bad input, RPC failure,
// and the never-blank proof card — all without touching the chain.
expectThrow('error: BTC $7,000,000 too large for the circuit', () => scaleValue('7000000', 'btc100'), /too large.*0–65535/);
expectThrow('error: negative raw value rejected', () => scaleValue('-5', 'raw'), /too small/);
expectThrow('error: non-numeric value rejected', () => scaleValue('abc', 'raw'), /not a number/);
expectThrow('error: raw 65536 out of range', () => scaleValue('65536', 'raw'), /too large/);
{
  const ok = scaleValue('65535', 'raw') === 65535;
  results.errors.push({ name: 'boundary: raw 65535 accepted', pass: ok });
  check('boundary: raw 65535 accepted', ok, '65535');
}
expectThrow('error: empty threshold rejected', () => buildProof({ question: 'x', thresholdRaw: '', observedRaw: '1', scaleKey: 'raw', mode: 'ge' }), /Enter a number for the threshold/);
expectThrow('error: non-numeric observed rejected', () => buildProof({ question: 'x', thresholdRaw: '1', observedRaw: 'abc', scaleKey: 'raw', mode: 'ge' }), /not a number/);
expectThrow('error: empty question rejected', () => buildProof({ question: '  ', thresholdRaw: '1', observedRaw: '1', scaleKey: 'raw', mode: 'ge' }), /Enter a question/);
expectThrow('error: unknown comparison mode rejected', () => buildProof({ question: 'x', thresholdRaw: '1', observedRaw: '1', scaleKey: 'raw', mode: 'xx' }), /unknown comparison mode/);
{
  // RPC failure: unreachable endpoints must throw a specific error fast
  // (connection refused, no 20 s timeout), and formatEvalError must turn
  // it into a plain message while passing input errors through unchanged.
  let rpcMsg = null;
  try { await rpc(['https://127.0.0.1:9'], 'eth_blockNumber', []); } catch (e) { rpcMsg = e.message; }
  const okRpc = rpcMsg !== null && /RPC failed on all endpoints/.test(rpcMsg);
  results.errors.push({ name: 'rpc: unreachable endpoints throw', message: rpcMsg, pass: okRpc });
  check('error: RPC failure is specific, not silent', okRpc, rpcMsg);
  const friendly = formatEvalError(new Error('RPC failed on all endpoints: connect ECONNREFUSED'));
  const okFriendly = friendly.startsWith('Could not reach the X Layer mainnet RPC');
  results.errors.push({ name: 'formatEvalError: RPC failure gets plain prefix', message: friendly, pass: okFriendly });
  check('error: RPC failure formatted in plain language', okFriendly, friendly);
  const inputMsg = 'Value 7000000 is too large for the circuit: at BTC price, $100 per unit it becomes 70000, but the circuit only accepts 0–65535. Try a smaller value or a coarser scale.';
  const okPass = formatEvalError(new Error(inputMsg)) === inputMsg;
  results.errors.push({ name: 'formatEvalError: input error passes through unchanged', pass: okPass });
  check('error: input error passes through unchanged', okPass);
  // An unevaluated proof card must say NOT EVALUATED, never render blank
  // and never show a TRUE/FALSE verdict it did not compute.
  const unevaluated = renderProofCard(buildProof({ question: 'x', thresholdRaw: '1', observedRaw: '1', scaleKey: 'raw', mode: 'ge' }));
  const okCard = unevaluated.includes('NOT EVALUATED') && !unevaluated.includes('>TRUE<') && !unevaluated.includes('>FALSE<');
  results.errors.push({ name: 'proof card: unevaluated shows NOT EVALUATED, never blank', pass: okCard });
  check('error: unevaluated proof card is never blank', okCard, 'shows NOT EVALUATED');
}

// 7. Static checks (Day 4): the page actually carries the presets, the
// mobile rules, and the stale-card clear — not just the module.
{
  const html = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  const css = fs.readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
  const js = fs.readFileSync(new URL('./app.js', import.meta.url), 'utf8');
  const s = (name, ok, detail) => { results.staticChecks.push({ name, pass: ok }); check(name, ok, detail); };
  for (const key of Object.keys(PRESETS)) {
    s(`static: preset button data-preset="${key}" in index.html`, html.includes(`data-preset="${key}"`));
  }
  s('static: preset labels match PRESETS', Object.values(PRESETS).every((p) => html.includes(p.label) && html.includes(p.detail)));
  s('static: number inputs use inputmode="decimal"', (html.match(/inputmode="decimal"/g) || []).length === 2, '2 inputs');
  s('static: buttons have 44px min-height (tappable)', css.includes('min-height: 44px'));
  s('static: inputs are 16px (no iOS auto-zoom)', css.includes('font-size: 16px'));
  s('static: proof-card table stacks on narrow screens', css.includes('.proof-card th, .proof-card td { display: block'));
  s('static: primary button is full-width', css.includes('button.primary') && css.includes('width: 100%'));
  s('static: app.js clears the old proof card before evaluating', js.includes("proofCard').innerHTML = ''"));
  s('static: app.js wires presets through the shared runEvaluation', js.includes('runEvaluation()') && js.includes('PRESETS['));
  s('static: app.js formats errors via formatEvalError', js.includes('formatEvalError(e)'));
  // Day 5: the log-window decision is written in the page copy and in the
  // shared module, not only in the build log.
  s('static: log section states the ~10,000-block / ~3-hour window', html.includes('last ~10,000 blocks (about 3 hours'));
  s('static: log section says older entries stay countable via count()', html.includes('count()'));
  s('static: log section says a full history needs an indexer (out of scope)', html.includes('indexer') && html.includes('no backend'));
  const vjs = fs.readFileSync(new URL('./verdict.js', import.meta.url), 'utf8');
  s('static: verdict.js exports LOG_WINDOW_BLOCKS = 10000', vjs.includes('export const LOG_WINDOW_BLOCKS = 10000'));
  s('static: LOG_WINDOW_BLOCKS value is 10000 at runtime', LOG_WINDOW_BLOCKS === 10000, String(LOG_WINDOW_BLOCKS));
}

// 8. Serve over local HTTP (Day 4): every page file must return 200.
{
  const appDir = new URL('.', import.meta.url).pathname;
  const server = spawn('python3', ['-m', 'http.server', '8123', '--directory', appDir], { stdio: 'ignore' });
  try {
    let up = false;
    for (let i = 0; i < 20 && !up; i++) {
      try { const r = await fetch('http://127.0.0.1:8123/index.html'); up = r.ok; } catch { await new Promise((r) => setTimeout(r, 250)); }
    }
    if (!up) throw new Error('local HTTP server did not come up on :8123');
    for (const f of ['index.html', 'styles.css', 'app.js', 'verdict.js', 'README.md']) {
      const r = await fetch('http://127.0.0.1:8123/' + f);
      const body = await r.text();
      const ok = r.status === 200 && body.length > 0;
      results.http.push({ file: f, status: r.status, bytes: body.length, pass: ok });
      check(`http: ${f} serves 200`, ok, `${r.status}, ${body.length} bytes`);
    }
    const servedHtml = await (await fetch('http://127.0.0.1:8123/index.html')).text();
    const okPreset = servedHtml.includes('preset-btn') && servedHtml.includes('data-preset="btc100k"');
    results.http.push({ file: 'index.html (served copy has presets)', pass: okPreset });
    check('http: served index.html carries the preset buttons', okPreset);
  } finally {
    server.kill();
  }
}

// 9. Testnet VerdictLog write (only with --log)
if (DO_LOG) {
  const claimA = results.claims.find((c) => c.name === 'A');
  const countBefore = await verdictLogCount();
  const data = encodeLogVerdictCall(claimA.claimHash, claimA.output);
  const pk = execFileSync('python3', ['-c', "import json; print(json.load(open('/home/hatch/workspace/tapeout/wallet.json'))['data'][0]['private_key'])"]).toString().trim();
  const out = execFileSync('cast', [
    'send', '--rpc-url', TESTNET.rpcs[0], '--private-key', pk,
    TESTNET.verdictLog, 'logVerdict(bytes32,uint8)', claimA.claimHash, String(claimA.output),
  ], { env: { ...process.env, PATH: process.env.HOME + '/.foundry/bin:' + process.env.PATH } }).toString();
  const txHash = (out.match(/transactionHash\s+(\S+)/) || [])[1];
  const blockNum = (out.match(/blockNumber\s+(\S+)/) || [])[1];
  const status = (out.match(/status\s+(\S+)/) || [])[1];
  if (!txHash) throw new Error('cast send output had no tx hash:\n' + out);
  // Wait for the receipt to be readable, then re-read count.
  let countAfter = countBefore;
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    countAfter = await verdictLogCount();
    if (countAfter === countBefore + 1) break;
  }
  const ok = status === '1' && countAfter === countBefore + 1;
  results.testnet = { countBefore, countAfter, txHash, blockNumber: blockNum ? Number(blockNum) : null, status, claimHash: claimA.claimHash, verdict: claimA.output, pass: ok };
  check('testnet logVerdict lands (receipt + count +1)', ok, `tx ${txHash}, status ${status}, count ${countBefore} -> ${countAfter}`);

  // Day 5: log-section read-back. The fresh entry must appear in the same
  // verdictLogEntries() read the page's log section runs — a write that
  // lands but never shows up in the list is a broken feature, not a pass.
  const entries = await verdictLogEntries();
  const found = entries.find((e) => e.id === countAfter && e.claimHash.toLowerCase() === claimA.claimHash.toLowerCase() && e.verdict === claimA.output);
  const foundTx = found && found.txHash.toLowerCase() === txHash.toLowerCase();
  const maxId = entries.length ? Math.max(...entries.map((e) => e.id)) : null;
  const okReadback = Boolean(found) && foundTx === true && maxId === countAfter;
  results.logReadback = { entriesReturned: entries.length, foundEntry: found || null, txMatches: foundTx, maxId, pass: okReadback };
  check('log read-back: fresh entry appears in verdictLogEntries()', okReadback, found ? `#${found.id} verdict ${found.verdict} block ${found.blockNumber}, tx match ${foundTx}, ${entries.length} entries in window, max id ${maxId}` : `entry #${countAfter} NOT in the ${entries.length} returned`);
} else {
  console.log('SKIP  testnet log write (run with --log to perform it)');
}

fs.writeFileSync(new URL('../data/day5-verification-20261124.json', import.meta.url), JSON.stringify(results, null, 2) + '\n');
console.log(failures === 0 ? `ALL CHECKS PASSED (${total}/${total})` : `${failures} OF ${total} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
