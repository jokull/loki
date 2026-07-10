import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { loginFn } from "../server/rpc";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Input, Label } from "../components/ui/input";
import { Callout } from "../components/ui/callout";
import { Eyebrow, Shell } from "../components/layout";
import { Brand } from "../components/brand";

export const Route = createFileRoute("/login")({
  component: Login,
});

function Login() {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<{
    status: "idle" | "sending" | "sent" | "error";
    msg?: string;
    devLink?: string;
  }>({ status: "idle" });

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
    <Shell width="narrow" className="flex flex-col gap-6">
      <Link to="/" className="text-lg text-foreground no-underline">
        <Brand />
      </Link>
      <Card>
        <CardHeader>
          <Eyebrow>Account</Eyebrow>
          <CardTitle className="text-xl">Sign in</CardTitle>
          <CardDescription>
            Manage your sites, keys, editor tokens, and secrets. We'll email you a one-time sign-in
            link — no password.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {state.status === "sent" ? (
            <div className="flex flex-col gap-3">
              <Callout variant="ok">
                Check your inbox — we sent a sign-in link to <b>{email}</b>. It expires in 15
                minutes.
              </Callout>
              {state.devLink && (
                <p className="text-sm text-muted-foreground">
                  Dev link:{" "}
                  <a href={state.devLink} className="break-all">
                    {state.devLink}
                  </a>
                </p>
              )}
            </div>
          ) : (
            <form onSubmit={submit} className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  required
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.currentTarget.value)}
                  placeholder="you@company.com"
                />
              </div>
              {state.status === "error" && <Callout variant="error">{state.msg}</Callout>}
              <Button variant="sky" type="submit" disabled={state.status === "sending"}>
                {state.status === "sending" ? "Sending…" : "Email me a sign-in link"}
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
      <p className="text-sm text-muted-foreground">
        New here? Signing in with a fresh email is all it takes — then claim a{" "}
        <code>{"{name}"}.loftur.app</code> from your dashboard.
      </p>
    </Shell>
  );
}
