// Starter templates for scaffold_template. Each is a coherent multi-file site an
// agent (or owner) can drop in with one call, then customize. Kept CMS-free (no
// content models / no migrations) so they publish cleanly out of the box; they
// showcase the platform's own primitives (auth, user, routes, islands).

export interface Template {
  description: string;
  files: Record<string, string>;
}

const STYLES = `:root { color-scheme: light dark; }
body { margin: 0; }
.wrap { font-family: ui-sans-serif, system-ui, sans-serif; max-width: 34rem;
  margin: 3rem auto; padding: 0 1.25rem; line-height: 1.6; }
h1 { letter-spacing: -0.02em; }
input, button { font: inherit; padding: .55rem .7rem; border-radius: 8px;
  border: 1px solid #8884; }
button { background: #cf551d; color: #fff; border: 0; cursor: pointer; font-weight: 600; }
form { display: flex; gap: .5rem; margin: 1rem 0; }
a { color: #cf551d; }
`;

export const TEMPLATES: Record<string, Template> = {
  members: {
    description:
      "A members-only site with built-in passwordless email login. Home shows a " +
      "sign-in form or a welcome; /members is gated on `user`. No schema needed.",
    files: {
      "loki.config.json": `{ "writableModels": [] }`,
      "styles.css": STYLES,
      "app.tsx": `export const head = { title: "Members" };\n`,
      "routes/index.tsx": `export async function loader({ user }) { return { user: user || null }; }
export default function Home({ user }) {
  if (user) {
    return (
      <main class="wrap">
        <h1>Welcome back</h1>
        <p>Signed in as {user.email} ({user.role}).</p>
        <p><a href="/members">Members area →</a> · <a href="/__auth/logout">Log out</a></p>
      </main>
    );
  }
  return (
    <main class="wrap">
      <h1>Members only</h1>
      <p>Sign in and we'll email you a magic link — no password.</p>
      <form method="post" action="/login">
        <input name="email" type="email" placeholder="you@example.com" required />
        <button>Email me a link</button>
      </form>
    </main>
  );
}
`,
      "routes/login.tsx": `export async function action({ request, env }) {
  const form = await request.formData();
  const email = String(form.get("email") || "");
  const r = await env.AUTH.requestMagicLink(email, "/members");
  if (!r.ok) return new Response(r.error || "Could not send link", { status: 400 });
  return { redirect: "/?sent=1" };
}
export default function Login() {
  return (<main class="wrap"><h1>Check your email</h1><p>We sent you a sign-in link.</p><p><a href="/">Back home</a></p></main>);
}
`,
      "routes/members.tsx": `export async function loader({ user }) { return { user: user || null }; }
export default function Members({ user }) {
  if (!user) return (<main class="wrap"><h1>Members only</h1><p>Please <a href="/">sign in</a>.</p></main>);
  return (
    <main class="wrap">
      <h1>Members area</h1>
      <p>Hi {user.email} — only signed-in members can see this.</p>
      <p><a href="/__auth/logout">Log out</a></p>
    </main>
  );
}
`,
    },
  },

  "link-in-bio": {
    description:
      "A single-page link-in-bio / profile with a set of links. Pure static SSR — " +
      "customize the name, bio, and links in routes/index.tsx.",
    files: {
      "loki.config.json": `{ "writableModels": [] }`,
      "styles.css": STYLES + `.card { text-align: center; }
.avatar { width: 88px; height: 88px; border-radius: 999px; background: #cf551d22;
  display: grid; place-items: center; font-size: 2rem; margin: 0 auto 1rem; }
.links { display: flex; flex-direction: column; gap: .6rem; margin-top: 1.5rem; }
.links a { display: block; padding: .8rem; border: 1px solid #8884; border-radius: 10px;
  text-decoration: none; color: inherit; font-weight: 600; }
.links a:hover { border-color: #cf551d; }
`,
      "app.tsx": `export const head = { title: "Ada Lovelace" };\n`,
      "routes/index.tsx": `const LINKS = [
  { label: "Website", href: "https://example.com" },
  { label: "GitHub", href: "https://github.com" },
  { label: "Email", href: "mailto:hi@example.com" },
];
export default function Home() {
  return (
    <main class="wrap card">
      <div class="avatar">✦</div>
      <h1>Ada Lovelace</h1>
      <p>Mathematician · writer · first programmer.</p>
      <nav class="links">
        {LINKS.map((l) => <a href={l.href}>{l.label}</a>)}
      </nav>
    </main>
  );
}
`,
    },
  },
};

export const TEMPLATE_NAMES = Object.keys(TEMPLATES);
