import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { loginFn } from "../server/rpc";

export const Route = createFileRoute("/login")({
  component: Login,
});

function Login() {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<
    { status: "idle" | "sending" | "sent" | "error"; msg?: string; devLink?: string }
  >({ status: "idle" });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setState({ status: "sending" });
    try {
      const r = await loginFn({ data: { email } });
      if (r.ok) setState({ status: "sent", devLink: r.devLink });
      else setState({ status: "error", msg: r.error });
    } catch {
      setState({ status: "error", msg: "Something went wrong. Try again." });
    }
  }

  return (
    <div className="wrap narrow stack">
      <Link to="/" className="brand"><span className="dot" />loftur</Link>
      <div className="card stack">
        <div>
          <p className="eyebrow">Account</p>
          <h1 style={{ fontSize: "1.5rem", margin: ".2rem 0 0" }}>Sign in</h1>
          <p className="muted small">
            Manage your sites, keys, editor tokens, and secrets. We'll email you a
            one-time sign-in link — no password.
          </p>
        </div>

        {state.status === "sent" ? (
          <div className="stack">
            <div className="notice ok">
              Check your inbox — we sent a sign-in link to <b>{email}</b>. It expires in 15 minutes.
            </div>
            {state.devLink && (
              <div className="small">
                <span className="muted">Dev link: </span>
                <a href={state.devLink}>{state.devLink}</a>
              </div>
            )}
          </div>
        ) : (
          <form onSubmit={submit} className="stack">
            <div>
              <label htmlFor="email">Email</label>
              <input
                id="email"
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.currentTarget.value)}
                placeholder="you@company.com"
              />
            </div>
            {state.status === "error" && <div className="notice err">{state.msg}</div>}
            <button className="btn primary" disabled={state.status === "sending"}>
              {state.status === "sending" ? "Sending…" : "Email me a sign-in link"}
            </button>
          </form>
        )}
      </div>
      <p className="small muted">
        New here? Signing in with a fresh email is all it takes — then claim a
        <code> {"{name}"}.loftur.app</code> from your dashboard.
      </p>
    </div>
  );
}
