// Blind e2e for loftur-web (account dashboard). Verifies:
//  - landing + login render
//  - account magic-link minted on LOKI verifies on WEB (shared SECRETS_KEY works
//    cross-worker) -> sets loftur_account cookie -> redirects to /dashboard
//  - /dashboard shows the signed-in email + the sites owned by that email
//  - /dashboard is gated when anonymous
const WRITE_KEY = process.env.WRITE_KEY;
if (!WRITE_KEY) throw new Error("WRITE_KEY missing (run under dotenvx -f .env)");
const WEB = "https://loftur-web.solberg.workers.dev";
const LOKI = "https://loftur.app";
const EMAIL = "jokull@triptojapan.com";

const results = [];
const ok = (label, cond, detail = "") => {
  results.push(!!cond);
  console.log(`${cond ? "✅" : "❌"} ${label}${detail ? " — " + detail : ""}`);
};
function cookieFrom(setCookie, name) {
  if (!setCookie) return null;
  const m = new RegExp(name + "=([^;]+)").exec(setCookie);
  return m ? m[1] : null;
}

async function main() {
  // 1. landing + login render
  const home = await fetch(WEB + "/");
  const homeText = await home.text();
  ok("landing renders (200, hero copy)", home.status === 200 && /Vibe-code a real site/.test(homeText));
  const login = await fetch(WEB + "/login");
  ok("login page renders", login.status === 200 && /sign-in link/i.test(await login.text()));

  // 2. mint an ACCOUNT magic link on loki (shares SECRETS_KEY + shared/account with web)
  const mm = await fetch(LOKI + "/__accountmagic", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + WRITE_KEY },
    body: JSON.stringify({ email: EMAIL, origin: WEB, redirectTo: "/dashboard" }),
  });
  const mmj = await mm.json();
  ok("account magic-link minted (cross-worker)", !!mmj.link, mmj.link ? mmj.link.slice(0, 62) + "…" : JSON.stringify(mmj));

  // 3. follow the verify link -> cookie + redirect
  const verify = await fetch(mmj.link, { redirect: "manual" });
  const setCookie = verify.headers.get("set-cookie");
  const session = cookieFrom(setCookie, "loftur_account");
  const loc = verify.headers.get("location") || "";
  ok(
    "verify sets loftur_account cookie + redirects to /dashboard",
    (verify.status === 301 || verify.status === 302 || verify.status === 307) && !!session && /\/dashboard/.test(loc),
    `status=${verify.status} loc=${loc} cookie=${session ? "yes" : "NO"}`,
  );

  // 4. dashboard WITH the session -> shows email + owned sites
  if (session) {
    const dash = await fetch(WEB + "/dashboard", { headers: { cookie: "loftur_account=" + session } });
    const dashText = await dash.text();
    ok("dashboard renders when signed in (200)", dash.status === 200 && /Your sites/.test(dashText));
    ok("dashboard shows the signed-in email", dashText.includes(EMAIL), EMAIL);
    ok("dashboard lists at least one owned site", /authlab\d+\.loftur\.app/.test(dashText), (dashText.match(/authlab\d+\.loftur\.app/) || ["none"])[0]);
    ok("dashboard exposes owner-key / tokens / secrets actions", /Owner key/.test(dashText) && /Editor tokens/.test(dashText) && /Secrets/.test(dashText));
  } else {
    ok("dashboard checks skipped (no session)", false);
  }

  // 5. dashboard WITHOUT a session -> gated (redirect to /login)
  const anon = await fetch(WEB + "/dashboard", { redirect: "manual" });
  const anonLoc = anon.headers.get("location") || "";
  ok(
    "dashboard gated when anonymous (redirect to /login)",
    (anon.status === 301 || anon.status === 302 || anon.status === 307) && /\/login/.test(anonLoc),
    `status=${anon.status} loc=${anonLoc}`,
  );

  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} checks passed — ${WEB}`);
  if (passed !== results.length) process.exit(1);
}
main().catch((e) => { console.error("FATAL", e); process.exit(1); });
