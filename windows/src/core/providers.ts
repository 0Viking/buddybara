// The other models the panel can chat with (chat.rs): cloud providers with a key,
// and model servers the user runs. Pure data and helpers, from Coucou's.

import type { Settings } from "./state";
import { N_ } from "../i18n/i18n";

export type ProviderId = "google" | "openai" | "openrouter" | "ollama" | "lmstudio" | "custom";

export interface ProviderDef {
  id: ProviderId;
  name: string;
  /** Its mark in settings/brands.ts ("" for none). */
  brand: string;
  /** Credential Manager entry of its key; null for the model servers. */
  key: string | null;
  placeholder: string;
  /** Where its key is made: the site as shown, and its API keys page. */
  site: string;
  keyUrl: string;
  /** Settings field holding a model server's address. */
  urlField: "ollamaUrl" | "lmstudioUrl" | "customUrl" | null;
  /** A model server's usual address on this computer ("" for none). */
  usual: string;
  /** When the saved model is not offered, the first one containing this is picked. */
  prefer: string | null;
  /** Its dot on the panel's drawer tabs (a black mark would vanish on a dark panel: green instead). */
  color: string;
}

export const PROVIDERS: readonly ProviderDef[] = [
  { id: "google", name: "Google AI", brand: "google", key: "google-api-key", placeholder: "AIza…", site: "aistudio.google.com", keyUrl: "https://aistudio.google.com/apikey", urlField: null, usual: "", prefer: "flash", color: "#8E75B2" },
  { id: "openai", name: "OpenAI", brand: "openai", key: "openai-api-key", placeholder: "sk-…", site: "platform.openai.com", keyUrl: "https://platform.openai.com/api-keys", urlField: null, usual: "", prefer: "mini", color: "#10A37F" },
  { id: "openrouter", name: "OpenRouter", brand: "openrouter", key: "openrouter-api-key", placeholder: "sk-or-…", site: "openrouter.ai/keys", keyUrl: "https://openrouter.ai/keys", urlField: null, usual: "", prefer: null, color: "#94A3B8" },
  { id: "ollama", name: "Ollama", brand: "ollama", key: null, placeholder: "", site: "", keyUrl: "", urlField: "ollamaUrl", usual: "http://127.0.0.1:11434", prefer: null, color: "var(--green)" },
  { id: "lmstudio", name: "LM Studio", brand: "lmstudio", key: null, placeholder: "", site: "", keyUrl: "", urlField: "lmstudioUrl", usual: "http://127.0.0.1:1234", prefer: null, color: "var(--green)" },
  // No usual address: any server that speaks the OpenAI API.
  { id: "custom", name: N_("OpenAI-compatible"), brand: "", key: null, placeholder: "", site: "", keyUrl: "", urlField: "customUrl", usual: "", prefer: null, color: "var(--green)" },
];

/** Credential Manager entry of the custom server's optional key (bound to its address). */
export const CUSTOM_SERVER_KEY = "openai-compatible-key";

export function providerDef(id: string): ProviderDef | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

/**
 * The providers the panel can chat with now, with the model picked for each:
 * a cloud one once it has a key (`keys`: which are stored) and a model, a
 * model server once it is connected.
 */
export function readyProviders(settings: Settings, keys: Record<string, boolean>): { def: ProviderDef; model: string }[] {
  return PROVIDERS.flatMap((def) => {
    const model = settings.chatModels[def.id] ?? "";
    const ready = def.urlField ? settings[def.urlField] !== "" : keys[def.key!] === true;
    return ready && model ? [{ def, model }] : [];
  });
}

/** The model to keep once the list arrives: the saved one if offered, else a sensible one. */
export function pickModel(provider: ProviderDef, offered: string[], current: string): string | null {
  if (offered.length === 0) return null;
  if (offered.includes(current)) return current;
  const preferred = provider.prefer ? offered.find((id) => id.includes(provider.prefer!)) : undefined;
  return preferred ?? offered[0];
}

// ── Where an address points ───────────────────────────────────────────────────

/** Mirrors net.rs: this machine, by name or address. */
export function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  return h === "0.0.0.0" || h === "::1" || h === "::" || h === "::ffff:127.0.0.1" || h === "::ffff:7f00:1";
}

/**
 * Where a server address sends what you type: this machine, another one over
 * https, another one in clear text (http), or nowhere valid. An empty field
 * means the usual address on this machine.
 */
export type Exposure = "local" | "remote" | "remote-http" | "invalid";

export function urlExposure(raw: string): Exposure {
  const text = raw.trim();
  if (!text) return "local";
  let url: URL;
  try {
    url = new URL(text.includes("://") ? text : `http://${text}`);
  } catch {
    return "invalid";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "invalid";
  if (!url.hostname || url.username || url.password) return "invalid";
  if (isLoopbackHost(url.hostname)) return "local";
  return url.protocol === "https:" ? "remote" : "remote-http";
}
