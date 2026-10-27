import type { Settings, SettingsPatch } from "../plugins/newsletter/settings.ts";
import { checkTheme, DEFAULT_THEME, type Theme, type ThemeCheck, themeChanges } from "../plugins/newsletter/theme.ts";
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
  const storageNote = $<HTMLElement>("[data-storage-note]");

  /** The settings as last saved. */
  const settings = JSON.parse(form.dataset.settings!) as Settings;
  // Becomes true with the first save, on this page load too.
  let configured = !!form.dataset.configured;
  /** The theme as last saved: null until it has loaded. Save waits for it, so a failed load can't save defaults over it. */
  let savedTheme: Theme | null = null;
  /** The theme being worked on here (a logo changes it). */
  let theme: Theme = DEFAULT_THEME;
  save.disabled = true;

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
    if (target.name === "images") {
      bucket.hidden = target.value !== "bucket";
      showStorage();
    }
    clearTimeout(timer);
    timer = setTimeout(render, 150);
  });

  // The choice is a note for people; where images really go is set by the
  // server's environment (S3_*). Say so when the two disagree.
  function showStorage() {
    const chosen = form.querySelector<HTMLInputElement>('input[name="images"]:checked')?.value;
    const actual = form.dataset.storage;
    storageNote.hidden = !chosen || chosen === actual;
    storageNote.textContent =
      actual === "bucket"
        ? "This server stores images in a bucket (S3_BUCKET is set), whatever is chosen here."
        : "This server still stores images on this computer: set the variables below and restart it to use a bucket.";
  }

  // ---------------------------------------------------------------- logo --

  $<HTMLInputElement>("[data-logo-file]").addEventListener("change", async (e) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    // The colours first, from the file itself: an image the browser can't
    // read isn't worth uploading.
    let colors: string[];
    const local = URL.createObjectURL(file);
    try {
      colors = await logoColors(local);
    } catch {
      status.textContent = "Couldn't read that image. Try a PNG.";
      return;
    } finally {
      URL.revokeObjectURL(local);
    }
    status.textContent = "Uploading logo…";
    try {
      const logo = await uploadImage(file, "logo");
      theme = { ...themeFromColors(colors, theme), logo };
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
      if (!savedTheme) throw new Error("the saved theme hasn't loaded");
      // Only what changed here, theme and settings alike, so saving doesn't
      // undo changes made meanwhile on the Theme page or by Claude.
      const themePatch = themeChanges(savedTheme, currentTheme());
      if (Object.keys(themePatch).length) {
        const result = await plugin<{ saved: boolean; theme: Theme; check: ThemeCheck }>("theme-update", {
          patch: themePatch,
        });
        if (!result.saved) {
          showProblems(result.check);
          throw new Error("the theme would be hard to read; see the problems above the preview");
        }
        savedTheme = theme = result.theme;
      }
      const settingsPatch = settingsChanges(settings, read());
      // The first save always writes the settings: that's what marks setup done.
      if (Object.keys(settingsPatch).length || !configured) {
        const result = await plugin<{ saved: boolean; errors: string[]; settings: Settings }>("settings-update", {
          patch: settingsPatch,
        });
        if (!result.saved) {
          showProblems(checkTheme(currentTheme()), result.errors);
          throw new Error(result.errors[0] ?? "check the settings");
        }
        Object.assign(settings, result.settings);
      }
      status.textContent = "Saved.";
      $<HTMLElement>("[data-connect]").hidden = false;
      if (!configured) $<HTMLElement>("[data-connect]").scrollIntoView({ behavior: "smooth", block: "start" });
      configured = true;
    } catch (err) {
      status.textContent = `Not saved: ${(err as Error).message}`;
    } finally {
      save.disabled = !savedTheme;
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
      // One connection per Admin: the token this button made before is
      // revoked, so they don't pile up. EmDash's scopes aren't per
      // collection, so the token reaches all content and media; the page
      // says so.
      const { items } = await admin<{ items: { id: string; name: string }[] }>("GET", "/admin/api-tokens");
      for (const old of items.filter((t) => t.name === TOKEN_NAME)) await admin("DELETE", `/admin/api-tokens/${old.id}`);
      const token = await admin<{ token: string }>("POST", "/admin/api-tokens", {
        name: TOKEN_NAME,
        scopes: ["content:read", "content:write", "media:read", "media:write", "mcp:tools:newsletter"],
      });
      const command =
        `claude mcp add --transport http --scope user newsletter ${form.dataset.mcpUrl} ` +
        `--header "Authorization: Bearer ${token.token}"`;
      const shown = $<HTMLElement>("[data-connect-command]");
      shown.textContent = command;
      $<HTMLElement>("[data-connect-done]").hidden = false;
      const copy = $<HTMLButtonElement>("[data-connect-copy]");
      copy.onclick = async () => {
        try {
          await navigator.clipboard.writeText(command);
          copy.textContent = "Copied";
        } catch {
          // No clipboard permission (some embedded browsers): select the
          // command, try the old copy command, and else leave it selected.
          const range = document.createRange();
          range.selectNodeContents(shown);
          getSelection()?.removeAllRanges();
          getSelection()?.addRange(range);
          copy.textContent = document.execCommand("copy") ? "Copied" : "Selected: press Ctrl+C (⌘C on a Mac)";
        }
      };
    } catch (err) {
      status.textContent = `Couldn't make the connection: ${(err as Error).message}`;
      go.disabled = false;
    }
  });

  // ---------------------------------------------------------------- start --

  fill(settings);
  showStorage();
  plugin<{ theme: Theme }>("theme-get", {})
    .then((r) => {
      savedTheme = theme = r.theme;
      save.disabled = false;
      if (theme.logo) {
        logoImg.src = theme.logo;
        logoImg.hidden = false;
      }
      render();
    })
    .catch((err) => {
      status.textContent = `Couldn't load the saved theme, so nothing can be saved: ${(err as Error).message}. Reload to try again.`;
      render();
    });
}

/** The settings fields that differ from the saved ones. */
function settingsChanges(saved: Settings, next: SettingsPatch): SettingsPatch {
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(next)) {
    if (JSON.stringify(value) !== JSON.stringify(saved[key as keyof Settings])) patch[key] = value;
  }
  return patch as SettingsPatch;
}

/** The name of the API token "Connect Claude" makes, so it can find and replace it. */
const TOKEN_NAME = "Claude Code (Settings page)";

/** An EmDash admin API call as the signed-in Admin. */
async function admin<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/_emdash/api${path}`, {
    method,
    credentials: "same-origin",
    headers: { "content-type": "application/json", "x-emdash-request": "1" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(json?.error?.message ?? `HTTP ${res.status}`);
  return json.data as T;
}
