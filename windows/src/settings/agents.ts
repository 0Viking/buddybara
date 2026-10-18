// Settings → Agents: every coding agent other than Claude Code, each going
// through the same steps — preview the exact diff, click to confirm, and only
// then does agents.rs back the file up and write it. Their activity then shows
// in Buddybara; Codex, Copilot CLI and Muse Code ask for permissions in the panel.

import { Bridge, type AgentHookStatus } from "../core/bridge";
import { clear, h } from "../views/dom";
import { t } from "../i18n/i18n";
import { markTile, pageOf, renderDiff } from "./parts";

const errorText = (err: unknown) => String(err).replace(/^Error:\s*/, "");

export function agentsPage(list: AgentHookStatus[] | null): HTMLElement {
  const card = h("div", { class: "card" });
  if (!list?.length) card.append(h("div", { class: "stack hint", text: t("Buddybara could not list the agents.") }));
  for (const status of list ?? []) card.append(agentBlock(status));
  return pageOf(
    t("Agents"),
    t("Show other coding agents in Buddybara. It adds its entries to each agent's own config: you see the exact change and where the backup goes before anything is written, and uninstalling removes only what Buddybara added."),
    card,
  );
}

function agentBlock(initial: AgentHookStatus): HTMLElement {
  let status = initial;
  const head = h("div", { class: "srow" });
  const body = h("div", {});
  const block = h("div", { class: "agent" }, head, body);

  async function refresh() {
    const fresh = (await Bridge.agentHooksList())?.find((a) => a.id === status.id);
    if (fresh) status = fresh;
    draw();
  }

  function draw() {
    clear(head);
    clear(body);
    const install = h("button", {
      class: "primary",
      text: status.installed ? t("Reinstall…") : t("Install…"),
      onclick: () => void showPreview(true),
    });
    // A hook pointing at a relay that isn't there would break the agent's hooks.
    if (!status.hookReady) {
      install.disabled = true;
      install.title = t("The relay isn't installed yet. Restart Buddybara.");
    }
    head.append(
      markTile(status.id, status.name, status.installed ? "on" : "off"),
      h("div", { class: "srow-text" },
        h("b", { text: status.name }),
        h("span", {
          text: status.approvals
            ? t("Activity, and Allow / Deny in the buddy")
            : t("Activity only — approvals stay in the agent"),
        }),
        h("span", { class: "path", text: status.path }),
      ),
      h("div", { class: "srow-ctl" },
        install,
        status.installed
          ? h("button", { class: "danger", text: t("Uninstall…"), onclick: () => void showPreview(false) })
          : null,
      ),
    );
  }

  async function showPreview(install: boolean) {
    let plan;
    try {
      plan = await Bridge.agentHooksPreview(status.id, install);
    } catch (err) {
      // An unreadable or unexpected config stops here rather than being
      // treated as empty and written over.
      clear(body);
      body.append(h("div", { class: "stack" },
        h("div", { class: "notice err", text: errorText(err) }),
        h("div", { class: "row" }, h("button", { text: t("Back"), onclick: draw })),
      ));
      return;
    }
    const review = h("div", { class: "stack" },
      h("div", {
        class: "hint",
        text: install
          ? t("This is exactly what changes for {name}. Nothing else is touched.", { name: status.name })
          : t("This removes Buddybara's entries only. Everything else stays."),
      }),
      renderDiff(plan.diff),
      h("div", { class: "row" }, h("span", {
        class: "path",
        text: plan.backup ? t("Backup → {path}", { path: plan.backup }) : t("No existing file — nothing to back up."),
      })),
    );
    const confirm = h("button", {
      class: install ? "primary" : "danger",
      text: install ? t("Back up and write") : t("Back up and remove"),
    });
    confirm.addEventListener("click", async () => {
      confirm.disabled = true;
      try {
        const backups = await Bridge.agentHooksApply(status.id, install, plan.fingerprint);
        const saved = backups
          ? t("Done. Previous version saved as {paths}.", { paths: backups.split("\n").join(", ") })
          : t("Done.");
        clear(review);
        review.append(h("div", { class: "notice ok", text: install ? `${saved} ${status.note}` : saved }));
        window.setTimeout(() => void refresh(), 2600);
      } catch (err) {
        confirm.disabled = false;
        review.append(h("div", { class: "notice err", text: t("Could not write: {error}", { error: errorText(err) }) }));
      }
    });
    review.append(h("div", { class: "row" }, confirm, h("button", { text: t("Cancel"), onclick: draw })));
    clear(body);
    body.append(review);
  }

  draw();
  return block;
}
