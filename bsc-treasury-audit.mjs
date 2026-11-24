#!/usr/bin/env node
// bsc-treasury-audit: list BEP-20 transfers out of (or into) a wallet over a block range,
// using only public BSC RPC (no explorer API key).
//
// usage:
//   node bsc-treasury-audit.mjs --token 0x... --wallet 0x... --from 123456 --to 234567
//   node bsc-treasury-audit.mjs --token 0x... --wallet 0x... --days 1
//
// output: JSON to stdout, one entry per transfer, plus a summary block.

const RPCS = [
  "https://bsc.publicnode.com",
  "https://bsc-dataseed.bnbchain.org",
  "https://1rpc.io/bnb",
];
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const CHUNK = 5000;

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf("--" + k); return i >= 0 ? args[i + 1] : d; };

const token = arg("token");
const wallet = arg("wallet");
if (!token || !wallet) {
  console.error("need --token 0x... --wallet 0x... (and --from/--to or --days)");
  process.exit(2);
}
const topic = "0x" + wallet.toLowerCase().replace(/^0x/, "").padStart(64, "0");

let id = 1;
async function rpc(url, method, params) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: id++, method, params }),
    signal: AbortSignal.timeout(30000),
  });
  const j = await res.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error).slice(0, 200)}`);
  return j.result;
}
let rpcUrl = RPCS[0];
async function call(method, params) {
  let last;
  for (const u of [rpcUrl, ...RPCS.filter((x) => x !== rpcUrl)]) {
    for (let i = 0; i < 2; i++) {
      try { const r = await rpc(u, method, params); rpcUrl = u; return r; }
      catch (e) { last = e; await new Promise((r) => setTimeout(r, 800 * (i + 1))); }
    }
  }
  throw last;
}

const head = Number(BigInt(await call("eth_blockNumber", [])));
const days = Number(arg("days", 0));
let fromBlock = Number(arg("from", 0));
let toBlock = Number(arg("to", head));
if (days > 0) {
  // BSC ~0.75s blocks; walk back roughly and refine by timestamp
  const approx = Math.floor((days * 86400) / 0.75);
  fromBlock = Math.max(0, head - approx);
  toBlock = head;
}

const out = [];
for (let start = fromBlock; start <= toBlock; start += CHUNK) {
  const end = Math.min(toBlock, start + CHUNK - 1);
  const logs = await call("eth_getLogs", [{
    address: token,
    fromBlock: "0x" + start.toString(16),
    toBlock: "0x" + end.toString(16),
    topics: [TRANSFER, topic],
  }]);
  for (const l of logs) {
    out.push({
      tx: l.transactionHash,
      block: Number(BigInt(l.blockNumber)),
      to: "0x" + l.topics[2].slice(26),
      amount_raw: BigInt(l.data).toString(),
      log_index: Number(BigInt(l.logIndex)),
    });
  }
  process.stderr.write(`scanned ${end - start + 1} blocks, ${out.length} transfers\r`);
}

const recipients = new Map();
let totalRaw = 0n;
for (const t of out) {
  totalRaw += BigInt(t.amount_raw);
  recipients.set(t.to, (recipients.get(t.to) || 0n) + BigInt(t.amount_raw));
}

console.log(JSON.stringify({
  token, wallet,
  fromBlock, toBlock,
  transfers: out,
  summary: {
    count: out.length,
    distinctRecipients: recipients.size,
    total_raw: totalRaw.toString(),
    total_18dp: (Number(totalRaw) / 1e18).toFixed(6),
  },
}, null, 2));
