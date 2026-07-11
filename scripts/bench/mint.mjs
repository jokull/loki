// Loftur Bench — mint N isolated account PATs (one per blind builder) via the
// WRITE_KEY-gated admin route. Run under dotenvx so WRITE_KEY is in env:
//   dotenvx run --quiet -f .env -- node scripts/bench/mint.mjs 6 | grep '^lftr_pat_'
const WK = process.env.WRITE_KEY;
if (!WK) throw new Error("WRITE_KEY missing (run under dotenvx -f .env)");
const APEX = process.env.LOFTUR_APEX || "https://loftur.app";
const n = Number(process.argv[2] || 6);
const out = [];
for (let i = 1; i <= n; i++) {
  const r = await fetch(APEX + "/__accounttoken", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + WK },
    body: JSON.stringify({ email: `bench-${i}@bench.loftur.app`, label: `bench-${i}` }),
  });
  const j = await r.json();
  if (!j.token) {
    console.error("mint failed:", JSON.stringify(j));
    process.exit(1);
  }
  out.push(j.token);
}
console.log(out.join("\n"));
