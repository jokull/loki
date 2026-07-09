// Transactional email capability for site isolates: env.MAIL.send({...}).
//
// A raw send_email binding can't cross the Worker-Loader boundary (like every
// other binding), so the isolate reaches it through this WorkerEntrypoint stub,
// which sends supervisor-side via env.EMAIL (Cloudflare Email Service). Sites use
// it for order confirmations, notifications, etc. — distinct from env.AUTH, which
// owns the magic-link login mail.
//
// v1: sends from a shared, verified loftur.app address (the onboarded sender
// domain); a per-site verified sender is a later refinement. There is NO rate
// limit yet — abuse controls land in the hardening phase.

import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "./env";
import { DEFAULT_SITE_ID } from "./site/store";

const FROM_ADDRESS = "noreply@loftur.app";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface MailInput {
  to: string;
  subject: string;
  html?: string;
  text?: string;
  replyTo?: string;
  fromName?: string;
}

export interface MailResult {
  ok: boolean;
  id?: string;
  error?: string;
}

export class MailEntrypoint extends WorkerEntrypoint<Env, { siteId?: string }> {
  async send(input: MailInput): Promise<MailResult> {
    const siteId = this.ctx.props?.siteId ?? DEFAULT_SITE_ID;
    const to = typeof input?.to === "string" ? input.to.trim() : "";
    if (!EMAIL_RE.test(to)) return { ok: false, error: "Invalid `to` address." };
    if (!input?.subject) return { ok: false, error: "`subject` is required." };
    if (!input.html && !input.text) {
      return { ok: false, error: "Provide `html` or `text`." };
    }
    if (!this.env.EMAIL) {
      return { ok: false, error: "Email is not configured on this deployment." };
    }
    try {
      const res = await this.env.EMAIL.send({
        to,
        from: { email: FROM_ADDRESS, name: input.fromName || "Loftur" },
        subject: input.subject,
        html: input.html,
        text: input.text,
        // reply-to isn't in the minimal typed surface; pass through if supported.
        ...(input.replyTo ? { replyTo: input.replyTo } : {}),
      } as any);
      return { ok: true, id: res?.messageId };
    } catch (err) {
      console.error(`[mail ${siteId}] send failed:`, err);
      return { ok: false, error: "Send failed." };
    }
  }
}
