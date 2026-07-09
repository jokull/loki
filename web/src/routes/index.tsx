import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  component: Home,
});

function Home() {
  return (
    <main style={{ fontFamily: "system-ui", maxWidth: "40rem", margin: "4rem auto", padding: "0 1rem" }}>
      <h1>Loftur web — hello from TanStack Start on Workers</h1>
      <p>Phase 0 scaffold is live.</p>
    </main>
  );
}
