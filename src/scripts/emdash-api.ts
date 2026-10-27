// EmDash calls the studio and the Theme page make as the signed-in user:
// media uploads (pasted and edited images, logos) and the newsletter plugin.

/** Uploads a file and returns its site path, e.g. /_emdash/api/media/file/01ABC.png. */
export async function uploadImage(file: File, prefix: string): Promise<string> {
  const form = new FormData();
  // Pasted screenshots are all called image.png; the prefix and the time
  // keep them apart in the media library.
  const ext = { "image/jpeg": "jpg", "image/svg+xml": "svg" }[file.type] ?? file.type.split("/")[1] ?? "png";
  const name = file.name && file.name !== `image.${ext}` ? file.name : `${prefix}-${Date.now()}.${ext}`;
  form.append("file", file, name);
  const res = await fetch("/_emdash/api/media", {
    method: "POST",
    credentials: "same-origin",
    headers: { "x-emdash-request": "1" },
    body: form,
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(json?.error?.message ?? `HTTP ${res.status}`);
  const item = json.data.item as { url?: string; storageKey: string };
  return item.url ?? `/_emdash/api/media/file/${item.storageKey}`;
}

/** Calls one of the newsletter plugin's routes. */
export async function plugin<T>(route: string, input: unknown): Promise<T> {
  const res = await fetch(`/_emdash/api/plugins/newsletter/${route}`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json", "x-emdash-request": "1" },
    body: JSON.stringify(input),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(json?.error?.message ?? `HTTP ${res.status}`);
  return json.data as T;
}
