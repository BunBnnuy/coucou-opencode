// Settings window — the place where anything that writes to disk is confirmed.
// Stage 2 covers the Claude Code hooks and the general preferences; API keys and
// integrations land here too in a later stage.

import "./settings.css";
import { Bridge, onEvent, type HookStatus } from "../core/bridge";
import { DEFAULT_SETTINGS, type Settings } from "../core/state";
import { applyThemeClass, DEFAULT_MOCHI, setMochiColor, systemPrefersLight } from "../core/theme";
import { h, clear } from "../views/dom";

let settings: Settings = { ...DEFAULT_SETTINGS };
let version = "";

const root = document.getElementById("settings-root")!;

async function save() {
  await Bridge.saveSettings(settings);
}

// ── Reusable bits ─────────────────────────────────────────────────────────────

function toggle(on: boolean, onChange: (v: boolean) => void): HTMLElement {
  const el = h("button", { class: on ? "switch on" : "switch", "aria-pressed": on });
  el.addEventListener("click", () => {
    const next = !el.classList.contains("on");
    el.classList.toggle("on", next);
    onChange(next);
  });
  return el;
}

function statusDot(ok: boolean): HTMLElement {
  return h("i", { class: "dot", style: `background:${ok ? "#22c55e" : "#f4505e"}` });
}

function renderDiff(text: string): HTMLElement {
  const box = h("div", { class: "diff" });
  for (const line of text.split("\n")) {
    const cls = line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "ctx";
    box.append(h("div", { class: cls, text: line }));
  }
  return box;
}

// ── Claude Code section ───────────────────────────────────────────────────────

function claudeSection(status: HookStatus): HTMLElement {
  const body = h("div", { style: "display:flex;flex-direction:column;gap:12px" });
  const section = h(
    "section",
    {},
    h("h2", {}, statusDot(status.installed), h("span", { text: "Claude Code" })),
    body,
  );

  const rebuild = async () => {
    const fresh = await Bridge.hooksStatus();
    if (fresh) Object.assign(status, fresh);
    clear(body);
    draw();
    const head = section.querySelector("h2")!;
    clear(head);
    head.append(statusDot(status.installed), h("span", { text: "Claude Code" }));
  };

  function draw() {
    body.append(
      h("div", {
        class: "hint",
        text: status.installed
          ? "Coucou is hooked into your Claude Code sessions. Tool calls, questions and permission requests show up in the island, and you can answer them there."
          : "Install the hooks to see your Claude Code sessions in the island and approve permissions without leaving what you are doing.",
      }),
      h("div", { class: "row" },
        h("label", { text: "settings.json" }),
        h("span", { class: "path", text: status.settingsPath }),
      ),
      h("div", { class: "row" },
        h("label", { text: "Relay" }),
        h("span", { class: "path", text: status.hookPath }),
        statusDot(status.hookReady),
      ),
    );

    if (!status.hookReady) {
      body.append(h("div", {
        class: "notice warn",
        text: "coucou-hook.exe is not in place yet. Restart Coucou; if it still fails, build it with `cargo build -p coucou-hook`.",
      }));
    }

    const actions = h("div", { class: "row" });
    const install = h("button", {
      class: "primary",
      text: status.installed ? "Reinstall hooks…" : "Install hooks…",
      onclick: () => showPreview(true),
    });
    // Writing hook commands that point at a relay which isn't there would give
    // every Claude Code session a broken hook and nothing to show for it.
    if (!status.hookReady) {
      install.disabled = true;
      install.title = "The relay isn't installed yet.";
    }
    actions.append(install);
    if (status.installed) {
      actions.append(h("button", {
        class: "danger",
        text: "Uninstall hooks…",
        onclick: () => showPreview(false),
      }));
    }
    body.append(actions);
  }

  async function showPreview(install: boolean) {
    let preview;
    try {
      preview = await Bridge.hooksPreview(install);
    } catch (err) {
      // An unreadable or invalid settings.json stops here rather than being
      // treated as empty and written over.
      clear(body);
      body.append(
        h("div", { class: "notice err", text: String(err).replace(/^Error:\s*/, "") }),
        h("div", { class: "row" }, h("button", {
          text: "Back",
          onclick: () => { clear(body); draw(); },
        })),
      );
      return;
    }
    if (!preview) return;
    clear(body);
    body.append(
      h("div", {
        class: "hint",
        text: install
          ? "This is exactly what will change in your settings.json. Your own hooks are left untouched."
          : "This removes Coucou's entries only. Your own hooks are left untouched.",
      }),
      renderDiff(preview.diff),
      h("div", { class: "row" },
        h("span", { class: "path", text: `Backup → ${preview.backup}` }),
      ),
    );
    const confirm = h("button", {
      class: install ? "primary" : "danger",
      text: install ? "Back up and write" : "Back up and remove",
    });
    confirm.addEventListener("click", async () => {
      confirm.disabled = true;
      try {
        const backup = await Bridge.hooksApply(install, preview.fingerprint);
        clear(body);
        body.append(h("div", {
          class: "notice ok",
          text: `Done. Previous settings saved as ${backup}. Open a new Claude Code session to pick the hooks up.`,
        }));
        window.setTimeout(() => void rebuild(), 2600);
      } catch (err) {
        confirm.disabled = false;
        body.append(h("div", { class: "notice err", text: `Could not write: ${String(err)}` }));
      }
    });
    body.append(h("div", { class: "row" }, confirm, h("button", {
      text: "Cancel",
      onclick: () => { clear(body); draw(); },
    })));
  }

  draw();
  return section;
}

// ── OpenCode section ──────────────────────────────────────────────────────────

function openCodeSection(installed: boolean): HTMLElement {
  let on = installed;
  const dot = statusDot(on);
  const note = h("div", { class: "hint" });
  const actions = h("div", { class: "row" });
  const feedback = h("div", {});
  const pathLine = h("span", {
    class: "path",
    text: "%USERPROFILE%\\.config\\opencode\\plugins\\coucou.ts",
  });

  function refresh() {
    dot.style.background = on ? "#22c55e" : "#f4505e";
    note.textContent = on
      ? "OpenCode sessions show up in the island too, and you can approve their permission requests from the notch. Restart OpenCode after a change."
      : "Install the plugin to watch your OpenCode sessions in the island and approve permissions from the notch.";
    clear(actions);
    clear(feedback);

    const install = h("button", {
      class: "primary",
      text: on ? "Reinstall plugin" : "Install plugin",
    });
    install.addEventListener("click", async () => {
      install.disabled = true;
      try {
        const where = await Bridge.openCodeInstall();
        on = true;
        refresh();
        feedback.append(h("div", { class: "notice ok", text: `Installed at ${where}. Restart OpenCode to pick it up.` }));
      } catch (err) {
        install.disabled = false;
        feedback.append(h("div", { class: "notice err", text: `Could not write: ${String(err)}` }));
      }
    });
    actions.append(install);

    if (on) {
      const remove = h("button", { class: "danger", text: "Uninstall plugin" });
      remove.addEventListener("click", async () => {
        remove.disabled = true;
        try {
          await Bridge.openCodeUninstall();
          on = false;
          refresh();
          feedback.append(h("div", { class: "notice ok", text: "Plugin removed." }));
        } catch (err) {
          remove.disabled = false;
          feedback.append(h("div", { class: "notice err", text: `Could not remove: ${String(err)}` }));
        }
      });
      actions.append(remove);
    }
  }

  refresh();
  return h(
    "section",
    {},
    h("h2", {}, dot, h("span", { text: "OpenCode" })),
    note,
    h("div", { class: "row" }, h("label", { text: "Plugin" }), pathLine),
    actions,
    feedback,
  );
}

// ── Chat section ──────────────────────────────────────────────────────────────

const ANTHROPIC_MODELS: [string, string][] = [
  ["claude-opus-5", "Claude Opus 5"],
  ["claude-sonnet-5", "Claude Sonnet 5"],
  ["claude-haiku-4-5", "Claude Haiku 4.5"],
];

/** OpenCode Go / Zen models that suit a quick chat. */
const OPENCODE_MODELS: [string, string][] = [
  ["deepseek-v4.1-flash", "DeepSeek V4.1 Flash"],
  ["deepseek-v4-flash", "DeepSeek V4 Flash"],
  ["deepseek-v4-pro", "DeepSeek V4 Pro"],
  ["glm-5.3-flash", "GLM 5.3 Flash"],
  ["kimi-k2.7-code", "Kimi K2.7 Code"],
  ["minimax-m3", "MiniMax M3"],
  ["qwen3.8-flash", "Qwen3.8 Flash"],
  ["grok-4.6", "Grok 4.6"],
];

function modelSelect(models: [string, string][], current: string, onChange: (id: string) => void): HTMLSelectElement {
  const select = h("select", {}) as HTMLSelectElement;
  for (const [id, label] of models) select.append(h("option", { value: id, text: label }));
  if (!models.some(([id]) => id === current)) {
    select.append(h("option", { value: current, text: current }));
  }
  select.value = current;
  select.addEventListener("change", () => onChange(select.value));
  return select;
}

function apiSection(): HTMLElement {
  const body = h("div", { style: "display:flex;flex-direction:column;gap:10px" });
  const section = h("section", {}, h("h2", {}, h("span", { text: "Chat" })), body);

  const provider = h("select", {}) as HTMLSelectElement;
  provider.append(
    h("option", { value: "anthropic", text: "Anthropic — Claude API" }),
    h("option", { value: "opencode", text: "OpenCode — Go / Zen" }),
  );
  provider.value = settings.chatProvider === "opencode" ? "opencode" : "anthropic";
  provider.addEventListener("change", () => {
    settings.chatProvider = provider.value;
    void save();
    draw();
  });

  /** A key row that only ever reports whether the key exists. */
  function keyRow(key: string, placeholder: string) {
    const dot = statusDot(false);
    const field = h("input", {
      type: "password",
      placeholder,
      style: "flex:1 1 auto;min-width:0",
      autocomplete: "off",
      spellcheck: "false",
    }) as HTMLInputElement;
    const saveBtn = h("button", { class: "primary", text: "Save key" });
    const clearBtn = h("button", { class: "danger", text: "Remove" });
    const row = h("div", { class: "row" }, h("label", { text: "API key" }), field, saveBtn, clearBtn, dot);

    async function refresh() {
      const present = (await Bridge.secretPresent(key)) ?? false;
      dot.style.background = present ? "#22c55e" : "#f4505e";
      field.placeholder = present ? "••••••••  (stored)" : placeholder;
      clearBtn.style.display = present ? "" : "none";
    }
    saveBtn.addEventListener("click", async () => {
      const value = field.value.trim();
      if (!value) return;
      try {
        await Bridge.secretSet(key, value);
        field.value = "";
        await refresh();
      } catch (err) {
        dot.style.background = "#f5a524";
        console.error(String(err));
      }
    });
    clearBtn.addEventListener("click", async () => {
      try {
        await Bridge.secretClear(key);
        await refresh();
      } catch (err) {
        console.error(String(err));
      }
    });
    return { row, refresh };
  }

  const anthropicKey = keyRow("anthropic-api-key", "sk-ant-...");
  const opencodeKey = keyRow("opencode-api-key", "oc_sk_...");

  const anthropicModel = modelSelect(ANTHROPIC_MODELS, settings.model, (id) => {
    settings.model = id;
    void save();
  });
  const opencodeModel = modelSelect(OPENCODE_MODELS, settings.opencodeModel || "deepseek-v4.1-flash", (id) => {
    settings.opencodeModel = id;
    void save();
  });

  function draw() {
    clear(body);
    body.append(h("div", { class: "row" }, h("label", { text: "Provider" }), provider));
    if (settings.chatProvider === "opencode") {
      body.append(
        opencodeKey.row,
        h("div", { class: "row" }, h("label", { text: "Model" }), opencodeModel),
        h("div", { class: "hint", text: "OpenCode Go / Zen key (oc_sk_…). It never touches disk." }),
      );
    } else {
      body.append(
        anthropicKey.row,
        h("div", { class: "row" }, h("label", { text: "Model" }), anthropicModel),
        h("div", { class: "hint", text: "Anthropic API key (sk-ant-…). It never touches disk." }),
      );
    }
  }

  draw();
  void anthropicKey.refresh();
  void opencodeKey.refresh();
  return section;
}

// ── Integrations section ──────────────────────────────────────────────────────

interface IntegrationDef {
  id: string;
  name: string;
  color: string;
  /** Credential Manager keys, in the order they are shown. */
  fields: { key: string; label: string; placeholder: string; secret: boolean }[];
}

const INTEGRATIONS: IntegrationDef[] = [
  { id: "integration_stripe", name: "Stripe", color: "#0570DE",
    fields: [{ key: "stripe-api-key", label: "Secret key", placeholder: "sk_live_…", secret: true }] },
  { id: "integration_github", name: "GitHub", color: "#F4505E",
    fields: [{ key: "github-token", label: "Token", placeholder: "ghp_…", secret: true }] },
  { id: "integration_vercel", name: "Vercel", color: "#7C5CFF",
    fields: [{ key: "vercel-token", label: "Token", placeholder: "…", secret: true }] },
  { id: "integration_n8n", name: "n8n", color: "#F29B38",
    fields: [
      { key: "n8n-url", label: "Instance URL", placeholder: "https://n8n.example.com", secret: false },
      { key: "n8n-api-key", label: "API key", placeholder: "…", secret: true },
    ] },
  { id: "integration_resend", name: "Resend", color: "#22C55E",
    fields: [{ key: "resend-api-key", label: "API key", placeholder: "re_…", secret: true }] },
  { id: "integration_notion", name: "Notion", color: "#8C8C8C",
    fields: [{ key: "notion-api-key", label: "Integration token", placeholder: "ntn_…", secret: true }] },
  { id: "integration_calcom", name: "Cal.com", color: "#C9956A",
    fields: [{ key: "calcom-api-key", label: "API key", placeholder: "cal_…", secret: true }] },
];

const MAX_ACTIVE = 4;

function integrationsSection(present: Record<string, boolean>): HTMLElement {
  const note = h("div", { class: "hint" });
  const list = h("div", { style: "display:flex;flex-direction:column;gap:14px" });

  function updateNote() {
    const used = settings.activeIntegrations.length;
    note.textContent = `Pick up to ${MAX_ACTIVE} pills to show next to Mochi — ${used}/${MAX_ACTIVE} in use. Keys are stored in the Windows Credential Manager, never on disk.`;
  }

  for (const def of INTEGRATIONS) {
    const active = settings.activeIntegrations.includes(def.id);
    const sw = h("button", { class: active ? "switch on" : "switch" });
    sw.addEventListener("click", () => {
      const on = settings.activeIntegrations.includes(def.id);
      if (on) {
        settings.activeIntegrations = settings.activeIntegrations.filter((x) => x !== def.id);
      } else {
        if (settings.activeIntegrations.length >= MAX_ACTIVE) return;
        settings.activeIntegrations = [...settings.activeIntegrations, def.id];
      }
      sw.classList.toggle("on", !on);
      updateNote();
      void save();
    });

    const rows = h("div", { style: "display:flex;flex-direction:column;gap:6px;flex:1 1 auto;min-width:0" });
    for (const field of def.fields) {
      const input = h("input", {
        type: field.secret ? "password" : "text",
        placeholder: present[field.key] ? "••••••••  (stored)" : field.placeholder,
        autocomplete: "off",
        spellcheck: "false",
        style: "flex:1 1 auto;min-width:0",
      }) as HTMLInputElement;
      const saveBtn = h("button", { text: "Save" });
      const dotEl = statusDot(present[field.key] ?? false);
      saveBtn.addEventListener("click", async () => {
        const value = input.value.trim();
        try {
          await Bridge.secretSet(field.key, value);
          present[field.key] = value.length > 0;
          input.value = "";
          input.placeholder = value ? "••••••••  (stored)" : field.placeholder;
          dotEl.style.background = value ? "#22c55e" : "#f4505e";
        } catch {
          dotEl.style.background = "#f5a524";
        }
      });
      rows.append(
        h("div", { class: "row" },
          h("label", { style: "min-width:104px", text: field.label }),
          input, saveBtn, dotEl,
        ),
      );
    }

    list.append(
      h("div", { style: "display:flex;gap:12px;align-items:flex-start" },
        h("div", { style: "display:flex;align-items:center;gap:8px;min-width:132px;padding-top:4px" },
          sw,
          h("i", { class: "dot", style: `background:${def.color}` }),
          h("span", { style: "font-size:12.5px", text: def.name }),
        ),
        rows,
      ),
    );
  }

  updateNote();
  return h("section", {}, h("h2", {}, h("span", { text: "Integrations" })), note, list);
}

// ── General section ───────────────────────────────────────────────────────────

function generalSection(): HTMLElement {
  const volume = h("input", {
    type: "range", min: "0", max: "0.2", step: "0.005",
    value: String(settings.soundVolume),
  }) as HTMLInputElement;
  volume.addEventListener("input", () => {
    settings.soundVolume = Number(volume.value);
    void save();
  });

  const autoClose = h("input", {
    type: "number", min: "5", max: "120", step: "1",
    value: String(Math.round(settings.autoCloseInterval)),
    style: "width:72px",
  }) as HTMLInputElement;
  autoClose.addEventListener("change", () => {
    settings.autoCloseInterval = Math.max(5, Math.min(120, Number(autoClose.value) || 15));
    autoClose.value = String(settings.autoCloseInterval);
    void save();
  });

  const screen = h("select", {}) as HTMLSelectElement;
  screen.append(
    h("option", { value: "primary", text: "Main display" }),
    h("option", { value: "cursor", text: "Display under the cursor" }),
  );
  screen.value = settings.screen;
  screen.addEventListener("change", () => {
    settings.screen = screen.value as Settings["screen"];
    void save();
  });

  const anchor = h("select", {}) as HTMLSelectElement;
  anchor.append(
    h("option", { value: "top", text: "Top edge" }),
    h("option", { value: "bottom", text: "Bottom edge (above the taskbar)" }),
  );
  anchor.value = settings.islandAnchor === "bottom" ? "bottom" : "top";
  anchor.addEventListener("change", () => {
    settings.islandAnchor = anchor.value;
    void save();
  });

  const centre = h("button", { text: "Center" });
  centre.addEventListener("click", () => {
    settings.islandOffsetX = 0.5;
    void save();
  });

  const theme = h("select", {}) as HTMLSelectElement;
  theme.append(
    h("option", { value: "dark", text: "Dark" }),
    h("option", { value: "light", text: "Light" }),
    h("option", { value: "system", text: "Follow Windows" }),
  );
  theme.value = settings.theme === "light" || settings.theme === "system" ? settings.theme : "dark";
  theme.addEventListener("change", () => {
    settings.theme = theme.value;
    applyThemeClass(settings.theme, systemPrefersLight());
    void save();
  });

  const mochiColor = h("input", {
    type: "color",
    value: settings.mochiColor || DEFAULT_MOCHI,
    style: "width:38px;height:24px;padding:0;border:0;border-radius:6px;background:transparent",
  }) as HTMLInputElement;
  mochiColor.addEventListener("input", () => {
    settings.mochiColor = mochiColor.value.toUpperCase();
    setMochiColor(settings.mochiColor);
    void save();
  });
  const mochiDefault = h("button", { text: "Default" });
  mochiDefault.addEventListener("click", () => {
    settings.mochiColor = DEFAULT_MOCHI;
    mochiColor.value = DEFAULT_MOCHI;
    setMochiColor(DEFAULT_MOCHI);
    void save();
  });

  const recent = h("input", {
    type: "number", min: "1", max: "30", step: "1",
    value: String(settings.recentThreads ?? 10),
    style: "width:70px",
  }) as HTMLInputElement;
  recent.addEventListener("change", () => {
    settings.recentThreads = Math.max(1, Math.min(30, Number(recent.value) || 10));
    recent.value = String(settings.recentThreads);
    void save();
  });

  return h(
    "section",
    {},
    h("h2", {}, h("span", { text: "General" })),
    h("div", { class: "row" },
      h("label", { text: "Sound" }),
      toggle(settings.soundEnabled, (v) => { settings.soundEnabled = v; void save(); }),
      volume,
    ),
    h("div", { class: "row" },
      h("label", { text: "Auto-close" }),
      autoClose,
      h("span", { class: "hint", text: "seconds after you leave the island" }),
    ),
    h("div", { class: "row" },
      h("label", { text: "Island lives on" }),
      screen,
    ),
    h("div", { class: "row" },
      h("label", { text: "Island edge" }),
      anchor,
      centre,
    ),
    h("div", { class: "row" },
      h("label", { text: "Theme" }),
      theme,
    ),
    h("div", { class: "row" },
      h("label", { text: "Mochi colour" }),
      mochiColor,
      mochiDefault,
    ),
    h("div", { class: "row" },
      h("label", { text: "T3 threads" }),
      recent,
      h("span", { class: "hint", text: "shown in the threads tab" }),
    ),
    h("div", { class: "hint", text: "Drag the island itself to move it — it snaps to the top or bottom edge and remembers where you left it." }),
    h("div", { class: "row" },
      h("label", { text: "Launch at startup" }),
      toggle(settings.autostart, (v) => { settings.autostart = v; void save(); }),
    ),
  );
}

// ── Boot ──────────────────────────────────────────────────────────────────────

async function main() {
  const boot = await Bridge.boot();
  if (boot) {
    settings = { ...settings, ...boot.settings };
    version = boot.version;
  }
  applyThemeClass(settings.theme ?? "dark", systemPrefersLight());
  window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => {
    if (settings.theme === "system") applyThemeClass("system", systemPrefersLight());
  });
  const status = (await Bridge.hooksStatus()) ?? {
    installed: false, settingsPath: "", hookPath: "", hookReady: false,
  };

  const openCodeInstalled = (await Bridge.openCodeStatus()) ?? false;

  const keys = [
    "stripe-api-key", "github-token", "vercel-token",
    "n8n-url", "n8n-api-key", "resend-api-key", "notion-api-key", "calcom-api-key",
  ];
  const present: Record<string, boolean> = {};
  for (const k of keys) present[k] = (await Bridge.secretPresent(k)) ?? false;

  clear(root);
  root.append(
    h("h1", {}, h("span", { text: "Coucou" }), h("span", { class: "version", text: version })),
    claudeSection(status),
    openCodeSection(openCodeInstalled),
    apiSection(),
    integrationsSection(present),
    generalSection(),
    h("div", {
      class: "hint",
      text: "No telemetry. Network requests only go to the services you configure yourself.",
    }),
  );

  void onEvent<Settings>("settings-changed", (s) => {
    settings = { ...settings, ...s };
    applyThemeClass(settings.theme ?? "dark", systemPrefersLight());
  });
}

void main();
