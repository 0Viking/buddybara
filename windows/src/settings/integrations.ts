// Settings → Integrations: the services the panel's Services tab shows, each
// with its switch and its keys, then the keys only Claude's runs use. Keys go
// to the Credential Manager, never to disk; an empty field saved removes one.

import { Bridge } from "../core/bridge";
import { SERVICES, type ServiceDef, type ServiceField } from "../core/services";
import type { Settings } from "../core/state";
import { h } from "../views/dom";
import { N_, t } from "../i18n/i18n";
import { markTile, pageOf, statusDot, toggle } from "./parts";

/** Where secrets.rs keeps the keys on this OS. */
const KEY_STORE = navigator.userAgent.includes("Windows")
  ? "Windows Credential Manager"
  : "Secret Service (GNOME Keyring, KWallet)";

/** Keys only Claude's runs get (code.rs KEYS_FOR_CLAUDE); GitHub's token is a service's. */
const CLAUDE_KEYS: (ServiceField & { name: string; brand: string; hint: string })[] = [
  {
    key: "obsidian-api-key",
    name: "Obsidian",
    brand: "obsidian",
    label: N_("API key"),
    placeholder: "…",
    secret: true,
    hint: N_("From Obsidian's Local REST API plugin (Settings → Local REST API). Claude reaches your vault through it while Obsidian is open."),
  },
];

/** Every key the page shows, for main.ts to ask about before drawing it. */
export const INTEGRATION_KEYS = [...SERVICES.flatMap((s) => s.fields.map((f) => f.key)), ...CLAUDE_KEYS.map((k) => k.key)];

/** A key's field, its Save button and its dot. `saved` runs once it is stored. */
function keyRow(field: ServiceField, present: Record<string, boolean>, saved: () => void): HTMLElement {
  const stored = () => `••••••••  ${t("(stored)")}`;
  const input = h("input", {
    type: field.secret ? "password" : "text",
    placeholder: present[field.key] ? stored() : field.placeholder,
    autocomplete: "off",
    spellcheck: "false",
    "aria-label": t(field.label),
  }) as HTMLInputElement;
  const dotEl = statusDot(present[field.key] ?? false);
  const save = h("button", { text: t("Save") });
  save.addEventListener("click", async () => {
    const value = input.value.trim();
    try {
      await Bridge.secretSet(field.key, value);
      present[field.key] = value.length > 0;
      input.value = "";
      input.placeholder = value ? stored() : field.placeholder;
      dotEl.style.background = value ? "var(--leaf)" : "var(--red)";
      saved();
    } catch {
      dotEl.style.background = "var(--amber)";
    }
  });
  return h("div", { class: "row" }, h("label", { text: t(field.label) }), input, save, dotEl);
}

function serviceBlock(def: ServiceDef, settings: Settings, save: () => void, present: Record<string, boolean>): HTMLElement {
  const on = () => settings.activeIntegrations.includes(def.id);
  // Switched on, or given a key while on: it is polled now, not at its next turn.
  const poll = () => {
    if (on()) void Bridge.refreshIntegration(def.id);
  };
  const sw = toggle(on(), (next) => {
    settings.activeIntegrations = next
      ? [...settings.activeIntegrations.filter((id) => id !== def.id), def.id]
      : settings.activeIntegrations.filter((id) => id !== def.id);
    void Promise.resolve(save()).then(poll);
  });
  return h("div", { class: "agent" },
    h("div", { class: "srow" },
      markTile(def.brand, def.name),
      h("div", { class: "srow-text" }, h("b", { text: def.name }), h("span", { text: t(def.kind) })),
      h("div", { class: "srow-ctl" }, sw),
    ),
    h("div", { class: "stack svc-keys" },
      ...def.fields.map((f) => keyRow(f, present, poll)),
      def.hint ? h("div", { class: "hint", text: t(def.hint) }) : null,
    ),
  );
}

export function integrationsPage(settings: Settings, save: () => void, present: Record<string, boolean>): HTMLElement {
  const claude = h("div", { class: "card" },
    h("h2", {}, h("span", { text: t("Keys for Claude") })),
    h("div", { class: "stack" },
      h("div", { class: "hint", text: t("Keys Claude can use: runs started from the buddy and its terminal get them. They are stored in the {store}, never on disk.", { store: KEY_STORE }) }),
      ...CLAUDE_KEYS.map((k) => h("div", { class: "key" },
        markTile(k.brand, k.name),
        h("div", { class: "key-body" },
          h("b", { text: k.name }),
          keyRow(k, present, () => {}),
          h("div", { class: "hint", text: t(k.hint) }),
        ),
      )),
    ),
  );
  return pageOf(
    t("Integrations"),
    t("Live status from the services you use, in the buddy's Services tab. Their keys stay in the {store}, never on disk.", { store: KEY_STORE }),
    h("div", { class: "card" }, ...SERVICES.map((def) => serviceBlock(def, settings, save, present))),
    claude,
  );
}
