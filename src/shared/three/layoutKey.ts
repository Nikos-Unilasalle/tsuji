/**
 * The key's letter in the operator's own layout, lower-cased. `e.code` is the
 * *physical* QWERTY position (Z is KeyW on AZERTY), and on macOS Option turns
 * `e.key` into a composed character (Option+Z → "Ω"), so neither works for an
 * Alt shortcut on its own. keyCode, deprecated but layout-aware for letters,
 * fills in when `e.key` isn't a plain letter.
 */
export function layoutKey(e: KeyboardEvent): string {
  const key = e.key.toLowerCase();
  if (key.length !== 1 || (key >= "a" && key <= "z")) return key;
  if (e.keyCode >= 65 && e.keyCode <= 90) return String.fromCharCode(e.keyCode).toLowerCase();
  return key;
}
