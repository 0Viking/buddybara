// Settings → AI models: the other models the panel can chat with (chat.rs). A
// cloud provider takes a key (kept in the Credential Manager) and a model; a
// model server takes an address, checked by Connect, and a model. They answer
// but get no tools: they never read files or act on the computer.

import { Bridge } from "../core/bridge";
import { CUSTOM_SERVER_KEY, PROVIDERS, pickModel, urlExposure, type ProviderDef } from "../core/providers";
import type { Settings } from "../core/state";
import { clear, h } from "../views/dom";
import { t } from "../i18n/i18n";
import { markTile, pageOf, statusDot } from "./parts";

const errorText = (err: unknown) => String(err).replace(/^Error:\s*/, "");

/** Every key the page shows, for main.ts to ask about before drawing it. */
export const MODEL_KEYS = [...PROVIDERS.flatMap((p) => (p.key ? [p.key] : [])), CUSTOM_SERVER_KEY];

/** What an address means for what you type, as a line under it. */
function exposureNotice(url: string, withKey: boolean): HTMLElement | null {
  switch (urlExposure(url)) {
    case "local":
      return h("div", { class: "hint", text: t("Nothing leaves your PC: the server runs on this computer.") });
    case "remote":
      return h("div", { class: "hint", text: t("This address is another machine: what you ask is sent to it.") });
    case "remote-http":
      return withKey
        ? h("div", { class: "notice warn", text: t("Warning: the key would be sent unencrypted (http://) to another machine. Use https://, or a server on this computer.") })
        : h("div", { class: "hint", text: t("This address is another machine, over plain http: what you ask travels unencrypted.") });
    case "invalid":
      return url.trim() ? h("div", { class: "notice err", text: t("Not a valid http:// or https:// address.") }) : null;
  }
}

/** The model picker of a provider: its list asked when drawn, the choice saved. */
function modelRow(def: ProviderDef, settings: Settings, save: () => void, known?: string[]): HTMLElement {
  const select = h("select", { "aria-label": t("Model") }) as HTMLSelectElement;
  const status = h("span", { class: "hint" });
  const fill = (ids: { id: string; label: string }[]) => {
    clear(select);
    for (const m of ids) select.append(h("option", { value: m.id, text: m.label }));
    const keep = pickModel(def, ids.map((m) => m.id), settings.chatModels[def.id] ?? "");
    if (keep) {
      select.value = keep;
      if (keep !== settings.chatModels[def.id]) {
        settings.chatModels = { ...settings.chatModels, [def.id]: keep };
        save();
      }
    }
    select.disabled = ids.length === 0;
  };
  select.addEventListener("change", () => {
    settings.chatModels = { ...settings.chatModels, [def.id]: select.value };
    save();
  });
  if (known) {
    fill(known.map((id) => ({ id, label: id })));
  } else {
    select.disabled = true;
    status.textContent = t("Loading…");
    Bridge.chatModels(def.id)
      .then((models) => {
        status.textContent = "";
        fill(models);
      })
      .catch((err) => {
        status.textContent = errorText(err);
        status.classList.add("err");
      });
  }
  return h("div", { class: "row" }, h("label", { text: t("Model") }), select, status);
}

/** "Key from {site}", the site a link to the provider's API keys page. */
function keyHint(def: ProviderDef): HTMLElement {
  const mark = "\u0001";
  const [before, after = ""] = t("Key from {site}", { site: mark }).split(mark);
  const link = h("button", { class: "link", text: def.site, title: def.keyUrl });
  link.addEventListener("click", () => void Bridge.openUrl(def.keyUrl));
  return h("div", { class: "hint" }, before, link, after);
}

function cloudBlock(def: ProviderDef, settings: Settings, save: () => void, present: Record<string, boolean>): HTMLElement {
  const key = def.key!;
  const body = h("div", { class: "stack svc-keys" });
  const draw = () => {
    clear(body);
    const stored = `••••••••  ${t("(stored)")}`;
    const input = h("input", {
      type: "password", autocomplete: "off", spellcheck: "false", "aria-label": t("API key"),
      placeholder: present[key] ? stored : def.placeholder,
    }) as HTMLInputElement;
    const dotEl = statusDot(present[key] ?? false);
    // A key stored and nothing typed: Remove. Typing a new one makes it Save again.
    const button = h("button", {}) as HTMLButtonElement;
    const relabel = () => {
      const typed = input.value.trim() !== "";
      const remove = present[key] === true && !typed;
      button.textContent = remove ? t("Remove") : t("Save");
      button.className = remove ? "danger" : "";
      button.disabled = !remove && !typed;
    };
    input.addEventListener("input", relabel);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && input.value.trim()) button.click();
    });
    relabel();
    // Saved empty, the key is taken out of the Credential Manager.
    button.addEventListener("click", async () => {
      const value = input.value.trim();
      try {
        await Bridge.secretSet(key, value);
        present[key] = value.length > 0;
        draw();
      } catch {
        dotEl.style.background = "var(--amber)";
      }
    });
    body.append(
      h("div", { class: "row" }, h("label", { text: t("API key") }), input, button, dotEl),
      keyHint(def),
    );
    if (present[key]) body.append(modelRow(def, settings, save));
  };
  draw();
  return h("div", { class: "agent" },
    h("div", { class: "srow" }, markTile(def.brand, def.name), h("div", { class: "srow-text" }, h("b", { text: def.name }))),
    body,
  );
}

function serverBlock(def: ProviderDef, settings: Settings, save: () => void, present: Record<string, boolean>): HTMLElement {
  const field = def.urlField!;
  const body = h("div", { class: "stack svc-keys" });
  const name = t(def.name);
  const draw = (models?: string[]) => {
    clear(body);
    const connected = settings[field] !== "";
    if (connected) {
      const disconnect = h("button", { class: "danger", text: t("Disconnect") });
      disconnect.addEventListener("click", async () => {
        settings[field] = "";
        const { [def.id]: _gone, ...rest } = settings.chatModels;
        settings.chatModels = rest;
        if (def.id === "custom") {
          await Bridge.secretSet(CUSTOM_SERVER_KEY, "").catch(() => {});
          present[CUSTOM_SERVER_KEY] = false;
        }
        save();
        draw();
      });
      body.append(
        h("div", { class: "row" }, h("span", { class: "path", text: settings[field] }), statusDot(true), disconnect),
        modelRow(def, settings, save, models),
      );
      const notice = exposureNotice(settings[field], def.id === "custom" && (present[CUSTOM_SERVER_KEY] ?? false));
      if (notice) body.append(notice);
      return;
    }
    const input = h("input", {
      type: "text", spellcheck: "false", autocomplete: "off", "aria-label": name,
      placeholder: def.usual || "https://llm.example.com",
    }) as HTMLInputElement;
    // A custom server may want a key: it goes to the Credential Manager, bound to this address.
    const key = h("input", {
      type: "password", autocomplete: "off", spellcheck: "false", placeholder: t("API key (optional)"),
    }) as HTMLInputElement;
    const connect = h("button", { class: "primary", text: t("Connect") });
    const status = h("div", {});
    const exposure = h("div", {});
    const showExposure = () => {
      clear(exposure);
      const notice = exposureNotice(input.value || def.usual, def.id === "custom" && key.value.trim() !== "");
      if (notice) exposure.append(notice);
    };
    input.addEventListener("input", showExposure);
    key.addEventListener("input", showExposure);
    connect.addEventListener("click", async () => {
      connect.disabled = true;
      clear(status);
      status.append(h("div", { class: "hint", text: t("Connecting…") }));
      try {
        if (def.id === "custom" && key.value.trim()) {
          await Bridge.localSetKey(input.value || def.usual, key.value.trim());
          present[CUSTOM_SERVER_KEY] = true;
        }
        const server = await Bridge.localConnect(def.id, input.value);
        if (!server.models.length) {
          clear(status);
          status.append(h("div", { class: "notice err", text: t("No models yet. Download one in {name} first.", { name }) }));
          connect.disabled = false;
          return;
        }
        settings[field] = server.url;
        save();
        draw(server.models);
      } catch (err) {
        clear(status);
        status.append(h("div", { class: "notice err", text: errorText(err) }));
        connect.disabled = false;
      }
    });
    body.append(h("div", { class: "row" }, h("label", { text: t("Address") }), input, connect));
    if (def.id === "custom") body.append(h("div", { class: "row" }, h("label", { text: t("API key") }), key));
    body.append(status, exposure);
    showExposure();
  };
  draw();
  return h("div", { class: "agent" },
    h("div", { class: "srow" }, markTile(def.brand, name), h("div", { class: "srow-text" }, h("b", { text: name }))),
    body,
  );
}

export function modelsPage(settings: Settings, save: () => void, present: Record<string, boolean>): HTMLElement {
  return pageOf(
    t("AI models"),
    t("Chat with Google AI, OpenAI, OpenRouter or a model you run yourself: open one as a tab in the panel's drawer, or pick it in the buddy's model menu for a new conversation. They answer, but get no tools: they can't read files or act on this computer."),
    h("div", { class: "card" },
      h("h2", {}, h("span", { text: t("Cloud providers") })),
      ...PROVIDERS.filter((p) => p.key).map((def) => cloudBlock(def, settings, save, present)),
    ),
    h("div", { class: "card" },
      h("h2", {}, h("span", { text: t("Models you run yourself") })),
      h("div", { class: "stack hint", text: t("Ollama or LM Studio (leave the address empty for the usual one on this computer), or any server that speaks the OpenAI API, such as vLLM or llama.cpp.") }),
      ...PROVIDERS.filter((p) => p.urlField).map((def) => serverBlock(def, settings, save, present)),
    ),
  );
}
