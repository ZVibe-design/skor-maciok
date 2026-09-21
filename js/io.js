// Export / import — the archive path (LAW 5: expiry is archive, not delete), and
// the safety net for the storage failure `store.js` reports as `corrupt`.
//
// Split into a pure half and a browser half. `serialize` and `parseGame` are
// strings in and strings out, so the two gates that matter — the version and the
// events array — are exercised in Node with no DOM and no browser. `exportGame`
// and `importGame` are the thin wrappers that move a Blob and a File.
//
// `parseGame` deliberately decides nothing about the game's *contents*. A payload
// that clears its two gates is handed to `store.replace()`, which re-validates
// every player and every event before anything is written. A file from disk is raw
// input (LAW 1), and the door that admits a state is the same door whether it came
// from localStorage or from a `.json` a player was sent — writing a second, more
// permissive validator here is exactly how the two come to disagree.
import { STATE_VERSION, store } from "./store.js";

/**
 * What a rejected file says. Indonesian, and phrased for the person holding the
 * phone: none of these names a field, a type, or a version number, because the
 * person reading it cannot act on any of those.
 */
export const IMPORT_MESSAGES = {
  unreadable: "Berkas tidak bisa dibaca.",
  notJson: "Berkas bukan JSON yang sah.",
  wrongVersion: "Berkas ini bukan dari versi aplikasi yang sama.",
  noEvents: "Berkas tidak memuat daftar kejadian.",
  replaceFailed: "Isi berkas tidak bisa dipakai untuk meja ini.",
};

/** The one way an export can fail, and the only one worth naming on screen. */
export const EXPORT_MESSAGES = {
  failed: "Berkas tidak bisa dibuat di perangkat ini.",
};

/** A rejected import, carrying a message already fit to show on screen. */
export class ImportError extends Error {
  constructor(message) {
    super(message);
    this.name = "ImportError";
  }
}

/**
 * The whole game as the text of a `.json` file.
 *
 * `JSON.stringify(state, null, 2)` rather than compact: the file is a backup a
 * player may open, mail to someone, or paste into a message when something has
 * gone wrong, and a wall of one-line JSON is unreadable for exactly that use.
 */
export function serialize(state) {
  return JSON.stringify(state, null, 2);
}

/**
 * The two gates a file must clear before `store.replace()` is even asked.
 *
 * Both are stated by the plan and both are load-bearing. The version gate stops a
 * file from a future shape being read as if it were this one — silently dropping
 * whatever fields the new version added. The events gate stops a well-formed JSON
 * *object* that is not a game at all (`{"version":1}`) from reaching `replace()`,
 * which would throw a `TypeError` naming an internal field.
 *
 * Anything past these two is `replace()`'s call, not this function's.
 */
export function parseGame(text) {
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new ImportError(IMPORT_MESSAGES.notJson);
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new ImportError(IMPORT_MESSAGES.notJson);
  }
  if (payload.version !== STATE_VERSION) {
    throw new ImportError(IMPORT_MESSAGES.wrongVersion);
  }
  if (!Array.isArray(payload.events)) {
    throw new ImportError(IMPORT_MESSAGES.noEvents);
  }
  return payload;
}

/** `skor-maciok-2026-09-21.json` — the date is the only thing that distinguishes two backups. */
export function exportFilename(date = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `skor-maciok-${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}.json`;
}

/**
 * Download the current game.
 *
 * The `<a download>` click is the only mechanism a browser offers for a save with
 * no server behind it, and `URL.revokeObjectURL` runs on the next tick rather than
 * after the click: revoking synchronously can cancel the download before the
 * browser has read the blob on a slow device.
 */
export function exportGame(date = new Date()) {
  const blob = new Blob([serialize(store.state())], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = exportFilename(date);
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  return a.download;
}

/**
 * Read a chosen file and return the payload — it does **not** touch the store.
 *
 * That separation is the whole safety property of import: the caller has to hold
 * the payload, ask the player what to do with it, and only then hand it to
 * `store.replace()`. A function that both read the file and replaced the game
 * would make "never silently overwrite a live session" a property of the caller's
 * discipline instead of a property of the code.
 */
export async function importGame(file) {
  let text;
  try {
    text = await file.text();
  } catch {
    throw new ImportError(IMPORT_MESSAGES.unreadable);
  }
  return parseGame(text);
}
