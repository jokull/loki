import { createFileRoute, redirect } from "@tanstack/react-router";
import { verifyFn } from "../server/rpc";

export const Route = createFileRoute("/auth/verify")({
  validateSearch: (s: Record<string, unknown>) => ({
    token: typeof s.token === "string" ? s.token : "",
  }),
  loaderDeps: ({ search }) => ({ token: search.token }),
  loader: async ({ deps }) => {
    const r = await verifyFn({ data: { token: deps.token } });
    if (r.ok) throw redirect({ href: r.redirectTo || "/dashboard" });
    throw redirect({ to: "/login" });
  },
  component: () => null,
});
