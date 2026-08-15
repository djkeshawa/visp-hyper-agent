/**
 * The Cockpit's served assets.
 *
 * This module is the single import surface for them; the document, the
 * stylesheet, and the client program live in `./ui/` because each is a large
 * verbatim asset and reading one should not mean scrolling past the others.
 */

import { COCKPIT_JAVASCRIPT } from "./ui/client-script.js";
import {
  COCKPIT_DOCUMENT_HEADERS,
  COCKPIT_HTML,
  COCKPIT_SCRIPT_PATH,
  COCKPIT_STYLE_PATH
} from "./ui/document.js";
import { COCKPIT_CSS } from "./ui/styles.js";

export {
  COCKPIT_CONTENT_SECURITY_POLICY,
  COCKPIT_DOCUMENT_HEADERS,
  COCKPIT_HTML,
  COCKPIT_REFERRER_POLICY,
  COCKPIT_SCRIPT_PATH,
  COCKPIT_STYLE_PATH
} from "./ui/document.js";
export { COCKPIT_CSS } from "./ui/styles.js";
export { COCKPIT_JAVASCRIPT } from "./ui/client-script.js";

export type CockpitStaticAsset = Readonly<{
  path: string;
  contentType: string;
  body: string;
  headers?: Readonly<Record<string, string>>;
}>;

export const COCKPIT_STATIC_ASSETS = Object.freeze([
  Object.freeze({
    path: "/",
    contentType: "text/html; charset=utf-8",
    body: COCKPIT_HTML,
    headers: COCKPIT_DOCUMENT_HEADERS
  }),
  Object.freeze({ path: COCKPIT_STYLE_PATH, contentType: "text/css; charset=utf-8", body: COCKPIT_CSS }),
  Object.freeze({
    path: COCKPIT_SCRIPT_PATH,
    contentType: "text/javascript; charset=utf-8",
    body: COCKPIT_JAVASCRIPT
  })
] satisfies readonly CockpitStaticAsset[]);
