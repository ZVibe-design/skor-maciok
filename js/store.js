// P3 — state and persistence. One append-only event log is the single source of
// truth (LAW 4 / LAW 5); scores are derived from it and are never stored here.
//
// This module deliberately knows nothing about what an event costs. DECISIONS.md
// C1 makes the `settle.js` boundary load-bearing: a correction from the field
// test has to cost that file plus an `npm test` re-run. The moment store.js
// imported settlement arithmetic — even only to validate an event on the way in
// — that stops being true. So the only thing checked here is the event union
// itself, and the two modules stay independent.

import { DEFAULT_START, HU_METHODS, KOIN, PENALTY_ROWS } from "./rules.js";

export const STORAGE_KEY = "zv-mj-chan.game.v1";
export const STATE_VERSION = 1;

/** Seat winds. The N/E/S/W the player reads is a UI concern — see SPEC.md. */
export const SEATS = ["tung", "nan", "si", "pei"];

/** The event union's discriminators — the same five settle.js switches on. */
export const EVENT_TYPES = ["hu", "penalty", "koin", "utang", "koreksi"];

export const STORAGE_MESSAGES = {
  unavailable: "Penyimpanan tidak tersedia — ekspor sebelum menutup",
  corrupt: "Data tersimpan tidak terbaca — ekspor sebelum menutup",
};

/**
 * An opaque event id.
 *
 * **Never call `crypto.randomUUID()` directly.** It is a `[SecureContext]` API:
 * it exists on `localhost` and on the Pages HTTPS origin, and it is `undefined`
 * over `http://<LAN-IP>:8000` — the exact address the dev server advertises so a
 * phone can be tested against it. A bare call crashes the first event recorded
 * over LAN. `crypto.getRandomValues` carries no such gate, so it is the fallback.
 *
 * The two branches return different *shapes* — a 36-char dashed UUID, or 32 hex
 * chars — so nothing downstream may assume a length or a UUID format. The id is
 * opaque and is only ever compared by equality. The optional `c` parameter is
 * what makes the fallback testable without monkeypatching a global.
 */
export function makeId(c = globalThis.crypto) {
  if (typeof c?.randomUUID === "function") return c.randomUUID();
  const bytes = c.getRandomValues(new Uint8Array(16));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A fresh game. `start` is a parameter here and a literal only in rules.js. */
export function emptyState({ start = DEFAULT_START, now = () => Date.now() } = {}) {
  return { version: STATE_VERSION, start, players: [], events: [], createdAt: now() };
}

/** Resolve the storage to use. An explicit `null` means "in-memory, on purpose". */
function resolveStorage(supplied) {
  if (supplied !== undefined) return supplied;
  try {
    return globalThis.localStorage ?? null;
  } catch {
    // Some sandboxed contexts throw on the property access itself.
    return null;
  }
}

/**
 * The store. `append()`/`undo()` are the only ways an event enters the log.
 *
 * `storage`, `now` and `id` are injectable so the whole thing runs under
 * `node:test` with no DOM and no clock.
 */
export function createStore({ storage, now = () => Date.now(), id = makeId } = {}) {
  let state = null; // loaded lazily — see ensure()
  let problem = null; // null | "unavailable" | "corrupt"
  let sealed = false; // the stored payload is unreadable — never write over it

  const backing = resolveStorage(storage);

  /**
   * Read the log. A store that has never been loaded is not an empty game —
   * it is an unknown one, and treating those as the same is how a save wipes a
   * night's play. Every entry point funnels through here, so no caller has to
   * remember to load first.
   */
  function read() {
    if (!backing) {
      problem = "unavailable";
      return emptyState({ now });
    }
    let raw;
    try {
      raw = backing.getItem(STORAGE_KEY);
    } catch {
      problem = "unavailable";
      return emptyState({ now });
    }
    if (raw === null || raw === "") return emptyState({ now });

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Present but unreadable is NOT the same as absent. Keep whatever is
      // there: it is the only copy, and the alternative is overwriting a game
      // that a JSON fix could still have recovered.
      problem = "corrupt";
      sealed = true;
      return emptyState({ now });
    }
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.events)) {
      problem = "corrupt";
      sealed = true;
      return emptyState({ now });
    }

    // Rows are validated on the way in, so a row that fails here was written by
    // another build or edited by hand. Same treatment as an unparseable payload:
    // report it, and refuse to write over it. A log that quietly loads a row it
    // cannot price scores every hand after it wrongly, and nothing says so.
    const players = parsed.players;
    try {
      if (!Number.isInteger(parsed.start) || parsed.start < 0) {
        throw new TypeError("start tidak valid");
      }
      // The roster is checked here for the same reason each event is: a player with no
      // `id` cannot be priced either. Without this, a hand-edited payload whose players
      // lost their ids loads with `problem() === null`, fills the four seat names, then
      // throws in `scoresFrom` — and because `init()` calls `render()` before it decides
      // whether to open setup, the throw takes setup down with it. Measured: an empty
      // score board showing Σ as `0` against a real 1200, no banner, and no way back in.
      //
      // Refused, not repaired. `setPlayers` mints an id for a nameless player because it
      // is the input path, where there is nothing yet to reference; here there may be
      // events pointing at the old ids, and a minted replacement would orphan all of
      // them silently. `replace()` refuses the same payload for the same reason — this
      // is the storage door agreeing with the import door.
      if (!Array.isArray(parsed.players)) throw new TypeError("players bukan array");
      for (const p of parsed.players) {
        if (!validPlayer(p)) throw new TypeError(`pemain tidak valid: ${JSON.stringify(p)}`);
      }
      for (const e of parsed.events) validate(e, { events: parsed.events, players });
    } catch {
      problem = "corrupt";
      sealed = true;
      return emptyState({ now });
    }
    return parsed;
  }

  function ensure() {
    if (state === null) state = read();
    return state;
  }

  function save() {
    if (sealed) return false; // never write over a payload we could not read
    if (!backing) return false;
    try {
      backing.setItem(STORAGE_KEY, JSON.stringify(state));
      problem = null;
      return true;
    } catch {
      // Quota exhausted, or storage revoked mid-session.
      problem = "unavailable";
      return false;
    }
  }

  /** A copy, so the append-only guarantee is structural rather than a promise. */
  function snapshot() {
    const s = ensure();
    return {
      ...s,
      players: s.players.map((p) => ({ ...p })),
      events: s.events.map((e) => ({ ...e })),
    };
  }

  /**
   * A stored player is real when it carries an id events can point at, a name, and a
   * seat this build knows. One predicate, because the three doors that admit a roster
   * disagreeing about what a player is is how a payload passes one and dies in another.
   *
   * An empty-string id counts as absent, not as an id: `setPlayers` mints a replacement
   * for exactly that value, and two players sharing `""` would make every event naming
   * it ambiguous. Minting is right only at the setup form, where nothing references the
   * players yet — a read or an import must refuse instead, or it orphans the rows that
   * point at the ids it replaced.
   */
  function validPlayer(p) {
    return (
      typeof p?.id === "string" &&
      p.id !== "" &&
      typeof p?.name === "string" &&
      SEATS.includes(p?.seat)
    );
  }

  /**
   * The door. Pricing an event is settle.js's job; what is checked here is the
   * log's own well-formedness — that the union can express the row, and that no
   * id in it names a player who is not at the table.
   *
   * The split is deliberate. Which fields an event *must* carry is its contract
   * with settle.js, and settle.js already enforces it by throwing. Which ids
   * are *still valid* is a property of the state — it goes stale when the
   * roster changes or a file is imported — and only the store can see that. So
   * the store checks referential integrity and nothing else, and the two rules
   * cannot drift into disagreeing about the same event.
   *
   * Both checks exist because the log is append-only: a row that cannot be read
   * back can never be removed, so a bad one would poison every score for the
   * rest of the night rather than failing once, visibly, at the tap.
   */
  function validate(event, { events, players }) {
    if (!event || typeof event !== "object") throw new TypeError("event harus objek");
    if (!EVENT_TYPES.includes(event.type)) {
      throw new TypeError(`tipe event tidak dikenal: ${JSON.stringify(event?.type)}`);
    }

    // The same kind of check as the line above, against the closed sets this
    // log can name: which YDSP penalty row, which koin combination, and which Hu
    // method. Each asks whether the union can express the value at all — exactly
    // what EVENT_TYPES asks about the type — and NOT which fields an event must
    // carry, which stays settle.js's rule (see the test that pins the split).
    //
    // They earn their place at the door because the log is append-only: a row that
    // cannot be priced poisons every score after it and can never be taken back out.
    // Measured before the first of them existed: such a row loaded clean, then
    // `scoresFrom` threw inside `renderTable`, and the app came up with a blank table
    // and no message at all — a silent death rather than the `corrupt` report Task 3
    // built for exactly this shape.
    if (event.type === "hu" && !(typeof event.method === "string" && Object.hasOwn(HU_METHODS, event.method))) {
      throw new TypeError(`metode hu tidak dikenal: ${JSON.stringify(event.method)}`);
    }

    if (event.type === "penalty" && !PENALTY_ROWS.some((r) => r.no === event.row)) {
      throw new TypeError(`baris penalti tidak dikenal: ${JSON.stringify(event.row)}`);
    }

    // The same rule against the third closed set. Measured before Task 8 was built:
    // a `koin` naming a kind `KOIN` does not declare loaded with `problem() === null`
    // and the row present, and then threw inside `scoresFrom` — the identical silent
    // death the penalty check above prevents, in the one flow Task 7 did not touch.
    // (Task 9 found the same gap for `hu.method`: it was the last one open.)
    //
    // `Object.hasOwn` rather than `in` or a plain truthiness test, because both
    // answer for `Object.prototype`: `"toString" in KOIN` is `true`, so the obvious
    // spelling of this check passes exactly the kind that breaks the arithmetic.
    if (event.type === "koin" && !(typeof event.kind === "string" && Object.hasOwn(KOIN, event.kind))) {
      throw new TypeError(`jenis koin tidak dikenal: ${JSON.stringify(event.kind)}`);
    }

    // The referential-integrity loop below checks each `*Id` against the roster; a
    // loan needs one more thing of the same kind, because its two ids have to name
    // **two** players and not one. A self-loan is not malformed — every field is
    // present and every id is real — it is a row the ledger cannot express, and
    // `loanTotals` would throw on it during render, which is the blank screen with
    // no banner that Tasks 7, 8 and 9 each closed for a different table.
    //
    // Guarded on `typeof ... === "string"` so a row *missing* an id falls through
    // to settle.js's field rule rather than being reported as a self-loan. The
    // split stated above is what this check is trying to stay on the right side of:
    // which ids are still valid is a state property; whether a field is there at
    // all is the event's contract with settle.js.
    if (event.type === "utang" && typeof event.borrowerId === "string" && event.borrowerId === event.lenderId) {
      throw new TypeError("borrowerId dan lenderId tidak boleh sama");
    }

    if (event.type === "koreksi") {
      if (typeof event.corrects !== "string" || event.corrects === "") {
        throw new TypeError("koreksi butuh corrects berisi id event");
      }
      if (!events.some((e) => e.id === event.corrects)) {
        // A koreksi pointing at nothing is a no-op the player reads as success.
        throw new TypeError(`tidak ada event dengan id ${JSON.stringify(event.corrects)}`);
      }
      return;
    }

    for (const [key, value] of Object.entries(event)) {
      if (key === "id" || !key.endsWith("Id")) continue;
      if (value === null || value === undefined) continue; // a self-draw has no discarderId
      if (!players.some((p) => p.id === value)) {
        throw new TypeError(`${key} tidak ada di daftar pemain: ${JSON.stringify(value)}`);
      }
    }
  }

  function append(event) {
    const s = ensure();
    validate(event, s);
    // max+1 rather than length+1: an imported log (Task 13) may not be
    // contiguous, and seq has to stay monotonic across it.
    const seq = s.events.reduce((m, e) => Math.max(m, e.seq ?? 0), 0) + 1;
    const stored = { ...event, id: id(), seq, ts: now() };
    s.events.push(stored);
    save();
    return { ...stored };
  }

  /** LAW 5 — undo is a compensating event. It never splices. */
  function undo(eventId, reason = "") {
    const s = ensure();
    if (!s.events.some((e) => e.id === eventId)) {
      throw new TypeError(`tidak ada event dengan id ${JSON.stringify(eventId)}`);
    }
    return append({ type: "koreksi", corrects: eventId, reason });
  }

  function setStart(start) {
    const s = ensure();
    if (!Number.isInteger(start) || start < 0) {
      throw new TypeError(`start harus bilangan bulat >= 0, dapat: ${JSON.stringify(start)}`);
    }
    s.start = start;
    save();
    return s.start;
  }

  /**
   * Seats must be a bijection onto the four winds, so a table cannot end up
   * with two Easts and no North. Ids are preserved when supplied — a re-run of
   * setup to fix a typo must not orphan the events already in the log.
   */
  function setPlayers(list) {
    const s = ensure();
    if (!Array.isArray(list) || list.length !== SEATS.length) {
      throw new TypeError(`butuh tepat ${SEATS.length} pemain, dapat: ${JSON.stringify(list?.length)}`);
    }
    const players = list.map((p) => {
      const name = typeof p?.name === "string" ? p.name.trim() : "";
      if (name === "") throw new TypeError("setiap pemain butuh nama");
      if (!SEATS.includes(p?.seat)) {
        throw new TypeError(`kursi tidak dikenal: ${JSON.stringify(p?.seat)}`);
      }
      return { id: typeof p?.id === "string" && p.id !== "" ? p.id : id(), name, seat: p.seat };
    });
    if (new Set(players.map((p) => p.seat)).size !== SEATS.length) {
      throw new TypeError("kursi pemain duplikat");
    }
    s.players = players;
    save();
    return players.map((p) => ({ ...p }));
  }

  /**
   * Wholesale replacement, for `io.js` import (Task 13). Import is the one path
   * that may overwrite a live session, and only behind the confirm dialog there.
   */
  function replace(next) {
    if (!next || typeof next !== "object") throw new TypeError("state harus objek");
    if (next.version !== STATE_VERSION) {
      throw new TypeError(`versi state tidak dikenal: ${JSON.stringify(next?.version)}`);
    }
    if (!Number.isInteger(next.start) || next.start < 0) throw new TypeError("start tidak valid");
    if (!Array.isArray(next.players) || !Array.isArray(next.events)) {
      throw new TypeError("state butuh players dan events berupa array");
    }
    for (const p of next.players) {
      if (!validPlayer(p)) throw new TypeError(`pemain tidak valid: ${JSON.stringify(p)}`);
    }
    for (const e of next.events) validate(e, next);
    state = {
      version: STATE_VERSION,
      start: next.start,
      players: next.players.map((p) => ({ ...p })),
      events: next.events.map((e) => ({ ...e })),
      createdAt: next.createdAt ?? now(),
    };
    sealed = false; // an explicit import is the one sanctioned overwrite
    save();
    return snapshot();
  }

  return {
    load: () => snapshot(),
    state: snapshot,
    events: () => snapshot().events,
    players: () => snapshot().players,
    start: () => ensure().start,
    append,
    undo,
    setStart,
    setPlayers,
    replace,
    save,
    // A store is only "persistent" if the last thing that happened to it worked.
    // `problem` is cleared by a successful save, so a table that recovers from a
    // full disk starts promising to keep the game again.
    isPersistent: () => (ensure(), !!backing && !sealed && problem === null),
    problem: () => (ensure(), problem),
    problemMessage: () => (ensure(), problem ? STORAGE_MESSAGES[problem] : null),
  };
}

/** The app-wide instance. `ui.js` and `io.js` share this one. */
export const store = createStore();
