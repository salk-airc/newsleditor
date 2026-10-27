import type { Settings, SettingsPatch } from "../plugins/newsletter/settings.ts";
import { checkTheme, DEFAULT_THEME, type Theme, type ThemeCheck } from "../plugins/newsletter/theme.ts";
import { plugin, uploadImage } from "./emdash-api.ts";
import { logoColors, themeFromColors } from "./logo-colors.ts";
import { previewFrame } from "./preview-frame.ts";
import { sampleEmail } from "./theme-editor.ts";

// The setup and Settings page (src/pages/newsletter/setup.astro): fills the
// form from the saved settings, previews the email as the name, signature and
// logo change, and saves the settings and theme through the newsletter
// plugin. "Connect Claude" makes an API token and approves the plugin's MCP
// tools, as scripts/connect-claude.sh does from a terminal.

export function startSetup(form: HTMLFormElement) {
  const $ = <T extends Element>(sel: string) => form.querySelector<T>(sel)!;
  const field = (name: string) => form.elements.namedItem(name) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
  const show = previewFrame($<HTMLIFrameElement>("[data-preview]"));
  const problems = $<HTMLUListElement>("[data-problems]");
  const status = $<HTMLElement>("[data-status]");
  const save = $<HTMLButtonElement>("[data-save]");
  const logoImg = $<HTMLImageElement>("[data-logo-img]");
  const swatches = $<HTMLElement>("[data-swatches]");
  const bucket = $<HTMLElement>("[data-bucket]");

  const settings = JSON.parse(form.dataset.settings!) as Settings;
  const configured = !!form.dataset.configured;
  let theme: Theme = DEFAULT_THEME;
  /** True once the theme here differs from the saved one (a logo was uploaded). */
  let themeChanged = false;

  // ------------------------------------------------------------ the form --

  function fill(s: Settings) {
    field("name").value = configured ? s.name : "";
    field("subject").value = s.subject;
    field("senderName").value = s.sender.name;
    field("senderEmail").value = s.sender.email;
    field("weekday").value = s.weekday === null ? "" : String(s.weekday);
    field("timeZone").value = s.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
    field("signature").value = s.signature;
    field("starter").value = s.starter;
    field("voice").value = s.voice;
    const images = form.querySelector<HTMLInputElement>(`input[name="images"][value="${s.images}"]`);
    if (images) images.checked = true;
    bucket.hidden = s.images !== "bucket";
  }

  function read(): SettingsPatch {
    const weekday = field("weekday").value;
    return {
      name: field("name").value.trim(),
      subject: field("subject").value.trim(),
      sender: { name: field("senderName").value.trim(), email: field("senderEmail").value.trim() },
      weekday: weekday === "" ? null : Number(weekday),
      timeZone: field("timeZone").value.trim(),
      signature: field("signature").value,
      starter: field("starter").value,
      voice: field("voice").value,
      images: (form.querySelector<HTMLInputElement>('input[name="images"]:checked')?.value ?? "local") as Settings["images"],
    };
  }

  // The theme as it will be saved: the name follows the newsletter's name
  // until someone sets a different one on the Theme page.
  function currentTheme(): Theme {
    const name = field("name").value.trim() || "Newsletter";
    return theme.nameLead === DEFAULT_THEME.nameLead || !configured ? { ...theme, nameLead: name } : theme;
  }

  function render() {
    const draft = { ...settings, ...read(), sender: settings.sender } as Settings;
    const t = currentTheme();
    showProblems(checkTheme(t));
    show(sampleEmail(t, draft));
  }

  function showProblems({ errors, warnings }: ThemeCheck, extra: string[] = []) {
    problems.replaceChildren(
      ...[...extra.map((m) => ["error", m]), ...errors.map((m) => ["error", m]), ...warnings.map((m) => ["warning", m])].map(
        ([kind, message]) => {
          const li = document.createElement("li");
          li.dataset.kind = kind;
          li.textContent = message!;
          return li;
        },
      ),
    );
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  form.addEventListener("input", (e) => {
    const target = e.target as HTMLInputElement;
    if (target.name === "images") bucket.hidden = target.value !== "bucket";
    clearTimeout(timer);
    timer = setTimeout(render, 150);
  });

  // ---------------------------------------------------------------- logo --

  $<HTMLInputElement>("[data-logo-file]").addEventListener("change", async (e) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    status.textContent = "Uploading logo…";
    try {
      const logo = await uploadImage(file, "logo");
      const colors = await logoColors(URL.createObjectURL(file));
      theme = { ...themeFromColors(colors, theme), logo };
      themeChanged = true;
      logoImg.src = logo;
      logoImg.hidden = false;
      swatches.replaceChildren(
        ...[theme.colors.accent, theme.colors.accent2].map((c) => {
          const span = document.createElement("span");
          span.style.background = c;
          span.title = c;
          return span;
        }),
      );
      status.textContent = colors.length
        ? "Colours taken from the logo."
        : "The logo has no strong colours, so the default ones stay.";
      render();
    } catch (err) {
      status.textContent = `Logo not uploaded: ${(err as Error).message}`;
    }
  });

  // ---------------------------------------------------------------- save --

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    save.disabled = true;
    status.textContent = "Saving…";
    try {
      const t = currentTheme();
      if (themeChanged || !configured || t.nameLead !== theme.nameLead) {
        const result = await plugin<{ saved: boolean; check: ThemeCheck }>("theme-update", { patch: t });
        if (!result.saved) {
          showProblems(result.check);
          throw new Error("the theme would be hard to read; see the problems above the preview");
        }
        theme = t;
        themeChanged = false;
      }
      const result = await plugin<{ saved: boolean; errors: string[]; settings: Settings }>("settings-update", {
        patch: read(),
      });
      if (!result.saved) {
        showProblems(checkTheme(currentTheme()), result.errors);
        throw new Error(result.errors[0] ?? "check the settings");
      }
      Object.assign(settings, result.settings);
      status.textContent = "Saved.";
      $<HTMLElement>("[data-connect]").hidden = false;
      if (!configured) $<HTMLElement>("[data-connect]").scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (err) {
      status.textContent = `Not saved: ${(err as Error).message}`;
    } finally {
      save.disabled = false;
    }
  });

  // ------------------------------------------------------ connect Claude --

  const go = form.querySelector<HTMLButtonElement>("[data-connect-go]");
  go?.addEventListener("click", async () => {
    go.disabled = true;
    try {
      // Approval covers the tools' exact definitions, so after an update that
      // changes them they hide until this runs again.
      await admin("PUT", "/admin/plugins/newsletter/mcp", { enabled: true });
      const token = await admin<{ token: string }>("POST", "/admin/api-tokens", {
        name: `claude-code-${new Date().toISOString().slice(0, 10)}`,
        scopes: ["content:read", "content:write", "media:read", "media:write", "mcp:tools:newsletter"],
      });
      const command =
        `claude mcp add --transport http --scope user newsletter ${form.dataset.mcpUrl} ` +
        `--header "Authorization: Bearer ${token.token}"`;
      $<HTMLElement>("[data-connect-command]").textContent = command;
      $<HTMLElement>("[data-connect-done]").hidden = false;
      $<HTMLButtonElement>("[data-connect-copy]").onclick = async (e) => {
        await navigator.clipboard.writeText(command);
        (e.target as HTMLButtonElement).textContent = "Copied";
      };
    } catch (err) {
      status.textContent = `Couldn't make the connection: ${(err as Error).message}`;
      go.disabled = false;
    }
  });

  // ---------------------------------------------------------------- start --

  fill(settings);
  plugin<{ theme: Theme }>("theme-get", {})
    .then((r) => {
      theme = r.theme;
      if (theme.logo) {
        logoImg.src = theme.logo;
        logoImg.hidden = false;
      }
      render();
    })
    .catch(() => render());
}

/** An EmDash admin API call as the signed-in Admin. */
async function admin<T = unknown>(method: string, path: string, body: unknown): Promise<T> {
  const res = await fetch(`/_emdash/api${path}`, {
    method,
    credentials: "same-origin",
    headers: { "content-type": "application/json", "x-emdash-request": "1" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(json?.error?.message ?? `HTTP ${res.status}`);
  return json.data as T;
}
