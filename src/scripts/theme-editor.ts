import { renderDesignedEmail } from "../plugins/newsletter/email-designed.ts";
import { DEFAULT_SETTINGS, type Settings } from "../plugins/newsletter/settings.ts";
import { checkTheme, DEFAULT_THEME, type Theme, type ThemeCheck, type ThemePatch } from "../plugins/newsletter/theme.ts";
import { plugin, uploadImage } from "./emdash-api.ts";
import { previewFrame } from "./preview-frame.ts";

// The Theme page (src/pages/newsletter/theme.astro): a form over the
// newsletter's theme and a live preview of a sample edition in it. Checks run
// as you type, with the same checkTheme the plugin uses before saving.

type ColorKey = keyof Theme["colors"];

/** A short edition that shows every part of a theme: sections, links, an image, bullets. */
export const SAMPLE = `Hi everyone,

Here's what an edition looks like in this theme.

### 1. A main section

A paragraph with a [link to something](https://example.com), **bold text** and a little more to read, so the line length shows.

![A picture, with its caption under it](/email/sample.png "w=240")

### Quick hits

- **A quick hit.** One or two sentences, ending on the useful fact.
- **Another one.** With a [link](https://example.com).

See you next time!
`;

/** The sample edition as an email in a theme, with the newsletter's signature. */
export function sampleEmail(theme: Theme, settings: Settings = DEFAULT_SETTINGS): string {
  return renderDesignedEmail(SAMPLE, {
    title: settings.name,
    date: new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }),
    theme,
    site: location.origin,
    resolveImage: (src) => new URL(src, location.origin).href,
    signature: settings.signature,
  });
}

export function startThemeEditor(root: HTMLElement) {
  const $ = <T extends Element>(sel: string) => root.querySelector<T>(sel)!;
  const form = $<HTMLFormElement>("[data-form]");
  const preview = $<HTMLIFrameElement>("[data-preview]");
  const problems = $<HTMLUListElement>("[data-problems]");
  const status = $<HTMLElement>("[data-status]");
  const save = $<HTMLButtonElement>("[data-save]");
  const dark = $<HTMLInputElement>("[data-dark]");
  const logoImg = $<HTMLImageElement>("[data-logo-img]");
  const logoNone = $<HTMLElement>("[data-logo-none]");
  const text = (name: string) => form.elements.namedItem(name) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

  let saved: Theme = DEFAULT_THEME;
  let theme: Theme = DEFAULT_THEME;
  let settings: Settings = DEFAULT_SETTINGS;
  // The form stays locked until the saved theme has loaded: typing earlier
  // would be wiped when it arrives, and saving without it would write the
  // defaults over the real theme.
  let loaded = false;
  const fieldsets = form.querySelectorAll("fieldset");
  fieldsets.forEach((f) => (f.disabled = true));
  const show = previewFrame(preview);

  // ---------------------------------------------------------- form <-> theme

  function fill(t: Theme) {
    for (const name of ["nameLead", "nameTail", "footer", "wordmark", "tagline", "font"] as const) text(name).value = t[name];
    for (const key of Object.keys(t.colors) as ColorKey[]) {
      $<HTMLInputElement>(`[data-color="${key}"]`).value = t.colors[key].toLowerCase();
      $<HTMLInputElement>(`[data-hex="${key}"]`).value = t.colors[key].toLowerCase();
    }
    $<HTMLInputElement>("[data-banner-on]").checked = t.banner.style === "glow";
    $<HTMLInputElement>("[data-banner-strength]").value = String(t.banner.strength);
    showLogo(t.logo);
  }

  function read(): Theme {
    const colors = { ...theme.colors };
    for (const key of Object.keys(colors) as ColorKey[]) colors[key] = $<HTMLInputElement>(`[data-hex="${key}"]`).value.trim();
    return {
      ...theme,
      nameLead: text("nameLead").value,
      nameTail: text("nameTail").value,
      footer: text("footer").value,
      wordmark: text("wordmark").value,
      tagline: text("tagline").value,
      font: text("font").value as Theme["font"],
      colors,
      banner: {
        style: $<HTMLInputElement>("[data-banner-on]").checked ? "glow" : "none",
        strength: Number($<HTMLInputElement>("[data-banner-strength]").value),
      },
    };
  }

  function showLogo(src: string | null) {
    logoImg.hidden = !src;
    logoNone.hidden = !!src;
    if (src) logoImg.src = src;
  }

  // ------------------------------------------------------------- preview --

  const validHex = (s: string) => /^#[0-9a-fA-F]{6}$/.test(s);

  function update() {
    theme = read();
    const bad = (Object.keys(theme.colors) as ColorKey[]).filter((k) => !validHex(theme.colors[k]));
    const check: ThemeCheck = bad.length
      ? { errors: bad.map((k) => `${k}: “${theme.colors[k]}” isn't a 6-digit hex colour like #3557a0.`), warnings: [] }
      : checkTheme(theme);
    showProblems(check);
    const changed = Object.keys(changes()).length > 0;
    save.disabled = !loaded || !changed || check.errors.length > 0;
    if (changed) status.textContent = "Not saved yet";
    else if (status.textContent === "Not saved yet") status.textContent = "";
    if (!bad.length) render();
  }

  // Only the fields that differ from the saved theme, so saving doesn't undo
  // a change made meanwhile elsewhere (Claude, another editor) to fields
  // nobody touched here.
  function changes(): ThemePatch {
    const patch: Record<string, unknown> = {};
    for (const key of Object.keys(theme) as (keyof Theme)[]) {
      if (key === "colors" || key === "banner") {
        // Colours compare without case: the form shows them in lower case.
        const was = saved[key] as Record<string, unknown>;
        const part = Object.fromEntries(
          Object.entries(theme[key]).filter(([k, v]) => String(v).toLowerCase() !== String(was[k]).toLowerCase()),
        );
        if (Object.keys(part).length) patch[key] = part;
      } else if (theme[key] !== saved[key]) patch[key] = theme[key];
    }
    return patch as ThemePatch;
  }

  function showProblems({ errors, warnings }: ThemeCheck) {
    problems.replaceChildren(
      ...[...errors.map((m) => ["error", m]), ...warnings.map((m) => ["warning", m])].map(([kind, message]) => {
        const li = document.createElement("li");
        li.dataset.kind = kind;
        li.textContent = message!;
        return li;
      }),
    );
  }

  function render() {
    let html = sampleEmail(theme, settings);
    // Images stay as they are in a dark mode: flip them back inside the
    // inverted frame.
    if (dark.checked) html = html.replace("</head>", "<style>img{filter:invert(1) hue-rotate(180deg)}</style></head>");
    preview.classList.toggle("is-dark", dark.checked);
    show(html);
  }

  // -------------------------------------------------------------- events --

  form.addEventListener("input", (e) => {
    const target = e.target as HTMLInputElement;
    // The swatch and the hex field follow each other.
    if (target.dataset.color) $<HTMLInputElement>(`[data-hex="${target.dataset.color}"]`).value = target.value;
    if (target.dataset.hex && validHex(target.value.trim()))
      $<HTMLInputElement>(`[data-color="${target.dataset.hex}"]`).value = target.value.trim().toLowerCase();
    update();
  });
  dark.addEventListener("change", render);

  $<HTMLInputElement>("[data-logo-file]").addEventListener("change", async (e) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    status.textContent = "Uploading logo…";
    try {
      theme = { ...read(), logo: await uploadImage(file, "logo") };
      showLogo(theme.logo);
      status.textContent = "";
      update();
    } catch (err) {
      status.textContent = `Logo not uploaded: ${(err as Error).message}`;
    }
  });
  $<HTMLButtonElement>("[data-logo-clear]").addEventListener("click", () => {
    theme = { ...read(), logo: null };
    showLogo(null);
    update();
  });

  $<HTMLButtonElement>("[data-reset]").addEventListener("click", () => {
    theme = saved;
    fill(saved);
    update();
    status.textContent = "";
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    save.disabled = true;
    status.textContent = "Saving…";
    try {
      const result = await plugin<{ saved: boolean; theme: Theme; check: ThemeCheck }>("theme-update", {
        patch: changes(),
      });
      showProblems(result.check);
      if (result.saved) {
        // The theme as stored, including changes made elsewhere meanwhile.
        saved = theme = result.theme;
        fill(theme);
        render();
        status.textContent = "Saved. Drafts opened from now on use it; reload any that are open.";
      } else {
        status.textContent = "Not saved: fix the problems above.";
        save.disabled = false;
      }
    } catch (err) {
      status.textContent = `Not saved: ${(err as Error).message}`;
      save.disabled = false;
    }
  });

  // ---------------------------------------------------------------- start --

  fill(theme);
  render();
  plugin<{ settings: Settings }>("settings-get", {})
    .then((r) => {
      settings = r.settings;
      render();
    })
    .catch(() => {
      // The preview just goes without the signature.
    });
  plugin<{ theme: Theme; updatedBy: string | null; updatedAt: string | null }>("theme-get", {})
    .then((r) => {
      saved = theme = r.theme;
      loaded = true;
      fieldsets.forEach((f) => (f.disabled = false));
      fill(theme);
      update();
      status.textContent = r.updatedAt
        ? `Last changed ${new Date(r.updatedAt).toLocaleString()}${r.updatedBy ? ` by ${r.updatedBy}` : ""}`
        : "";
    })
    .catch(
      (err) => (status.textContent = `Couldn't load the saved theme, so it can't be changed here: ${(err as Error).message}. Reload to try again.`),
    );
}
