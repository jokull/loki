import { createFileRoute, redirect } from "@tanstack/react-router";
import { logoutFn } from "../server/rpc";

export const Route = createFileRoute("/auth/logout")({
  loader: async () => {
    await logoutFn();
    throw redirect({ to: "/login" });
  },
  component: () => null,
});
