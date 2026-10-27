import { defineLiveCollection } from "astro:content";
import { emdashLoader } from "emdash/runtime";

// EmDash serves its collections through Astro's Live Collections API, so
// content edited in the admin is read at request time rather than baked in at
// build time.
export const collections = {
  _emdash: defineLiveCollection({ loader: emdashLoader() }),
};
