/** Shared by the server-rendered page shell and the browser bundle (kept free of Node imports). */

/** id of the JSON data block that carries the page settings. A data block is never executed. */
export const CONFIG_ELEMENT_ID = "cofer-cfg";

/** JSON safe to place inside a <script type="application/json"> block: no "<" can close it. */
export function configJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}
