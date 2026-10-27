// A preview iframe that follows edits without reloading: the first render
// loads with srcdoc, later ones swap the new <body> (and <head>, if it
// changed) into the page already there. Setting srcdoc on every change made
// the frame flash and reload its fonts and images, e.g. while dragging a
// colour picker. The studio's preview (edition-editor.ts) works the same way.

export function previewFrame(frame: HTMLIFrameElement): (html: string) => void {
  let loading = false;
  let scrollY = 0;
  frame.addEventListener("load", () => {
    loading = false;
    frame.contentWindow?.scrollTo(0, scrollY);
  });

  return (html) => {
    const page = frame.contentDocument;
    if (!loading && page?.body && frame.srcdoc) {
      const next = new DOMParser().parseFromString(html, "text/html");
      if (page.head.innerHTML !== next.head.innerHTML) page.head.innerHTML = next.head.innerHTML;
      page.documentElement.replaceChild(page.importNode(next.body, true), page.body);
    } else {
      if (!loading) scrollY = frame.contentWindow?.scrollY ?? 0;
      loading = true;
      frame.srcdoc = html;
    }
  };
}
