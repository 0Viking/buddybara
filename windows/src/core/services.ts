// The services the panel's Services tab shows, polled by integrations.rs: their
// fields in Settings → Integrations (kept in the Credential Manager), and the
// page each card opens.

import { N_ } from "../i18n/i18n";

export interface ServiceField {
  /** The Credential Manager key (secrets.rs). */
  key: string;
  label: string;
  placeholder: string;
  secret: boolean;
}

export interface ServiceDef {
  /** In settings.activeIntegrations when it is on; the `integration` events' id. */
  id: string;
  /** Its mark in settings/brands.ts. */
  brand: string;
  name: string;
  /** What its card shows, in a word. */
  kind: string;
  fields: ServiceField[];
  /** What the key needs, under its fields. */
  hint?: string;
  /** Its dashboard. n8n has none: it opens the instance's own address. */
  open?: string;
}

export const SERVICES: readonly ServiceDef[] = [
  {
    id: "integration_github", brand: "github", name: "GitHub", kind: N_("Overview"), open: "https://github.com",
    fields: [{ key: "github-token", label: N_("Token"), placeholder: "github_pat_… / ghp_…", secret: true }],
    hint: N_("Classic token with the repo scope, or fine-grained with read access to Pull requests, Commit statuses and Actions. Claude's runs get it too, for gh and the GitHub API."),
  },
  {
    id: "integration_stripe", brand: "stripe", name: "Stripe", kind: N_("Payments"), open: "https://dashboard.stripe.com/payments",
    fields: [{ key: "stripe-api-key", label: N_("Secret key"), placeholder: "sk_live_… / rk_live_…", secret: true }],
  },
  {
    id: "integration_vercel", brand: "vercel", name: "Vercel", kind: N_("Deployments"), open: "https://vercel.com/dashboard",
    fields: [{ key: "vercel-token", label: N_("Token"), placeholder: "…", secret: true }],
  },
  {
    id: "integration_n8n", brand: "n8n", name: "n8n", kind: N_("Workflow"),
    fields: [
      { key: "n8n-url", label: N_("Instance URL"), placeholder: "https://n8n.example.com", secret: false },
      { key: "n8n-api-key", label: N_("API key"), placeholder: "…", secret: true },
    ],
  },
  {
    id: "integration_resend", brand: "resend", name: "Resend", kind: N_("Emails"), open: "https://resend.com/emails",
    fields: [{ key: "resend-api-key", label: N_("API key"), placeholder: "re_…", secret: true }],
  },
  {
    id: "integration_notion", brand: "notion", name: "Notion", kind: N_("Recent"), open: "https://notion.so",
    fields: [{ key: "notion-api-key", label: N_("Integration token"), placeholder: "ntn_…", secret: true }],
  },
  {
    id: "integration_calcom", brand: "cal-com", name: "Cal.com", kind: N_("Schedule"), open: "https://app.cal.com/bookings",
    fields: [{ key: "calcom-api-key", label: N_("API key"), placeholder: "cal_…", secret: true }],
  },
];
