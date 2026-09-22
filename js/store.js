// P3 — state and persistence. One append-only event log is the single source of
// truth (LAW 4 / LAW 5); scores are derived from it and are never stored here.
//
// This module deliberately knows nothing about what an event costs. DECISIONS.md
// C1 makes the `settle.js` boundary load-bearing: a correction from the field
// test has to cost that file plus an `npm test` re-run. The moment store.js
// imported settlement arithmetic — even only to validate an event on the way in
// — that stops being true. So the only thing checked here is the event union
// itself, and the two modules stay independent.

import { DEFAULT_START, HU_METHODS, KOIN, MAX_ENTRY, PENALTY_ROWS } from "./rules.js";

export const STORAGE_KEY = "zv-mj-chan.game.v1";
export const STATE_VERSION = 1;

/**
 * Reset's archive (LAW 5: expiry = archive, not delete). One entry per reset,
 * newest first, capped at `ARCHIVE_MAX`.
 *
 * Entries are the **raw stored strings**, never a re-serialised `state`. `read()`
 * falls back to `emptyState()` for a payload it cannot parse or validate, so
 * anything rebuilt from `state` after a failed read would be an empty game wearing
 * a real game's place in the archive. The raw string is the only artefact that
 * cannot lie about what was there.
 */
export const ARCHIVE_KEY = "zv-mj-chan.arsip.v1";

/**
 * How many retired games the archive keeps. Twenty is not a storage limit — an
 * entry is a few KB against a 5 MB quota — it is the bound that stops a device
 * nobody administers from growing this forever. The oldest entry is dropped at the
 * cap, and the confirm in `ui.js` says so **before** the player commits: an
 * unannounced truncation would satisfy LAW 5 only until the twenty-first reset.
 */
export const ARCHIVE_MAX = 20;

/** Seat winds. The N/E/S/W the player reads is a UI concern — see SPEC.md. */
export const SEATS = ["tung", "nan", "si", "pei"];

/** The event union's discriminators — the same five settle.js switches on. */
export const EVENT_TYPES = ["hu", "penalty", "koin", "utang", "koreksi"];

export const STORAGE_MESSAGES = {
  unavailable: "Penyimpanan tidak tersedia — ekspor sebelum menutup",
  corrupt: "Data tersimpan tidak terbaca — ekspor sebelum menutup",
};

/**
 * Reset's own refusal. Kept apart from `STORAGE_MESSAGES`, which names a *storage*
 * fault the player can only answer by exporting; this one names a table with
 * nothing to archive, which is a normal state and not a fault at all. The Reset
 * control is hidden in that state, so reading this means the log emptied between
 * the render and the tap.
 */
export const ARCHIVE_MESSAGES = {
  empty: "tidak ada yang diarsipkan",
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

/**
 * Is this a starting stack the app accepts? One predicate, four callers: `read()` and
 * `replace()` and `setStart()` in this file, plus the setup form in ui.js.
 *
 * Module-level and exported, unlike `validPlayer` inside the factory, because a fourth
 * caller lives in another module — and one predicate with four callers is the whole
 * point of it. The floor used to be spelled out at each door as
 * `!Number.isInteger(start) || start < 0`: one rule written four times, therefore four
 * chances to drift, and this project has already paid for exactly that when three doors
 * disagreed about what a player is (v19). A ceiling added four times would be the same
 * mistake with a bigger number.
 *
 * The ceiling belongs at the door rather than only at the setup form because the door is
 * what admits a hand-edited or imported payload: a bound enforced only in a form is
 * enforced nowhere, and a form cannot stop a file.
 *
 * `0` is legal and load-bearing, which is why this is `>= 0` and never a truthiness
 * test — a zero table is a real table (verified in the browser, 18/18), and
 * `openSetup`'s `start ?? DEFAULT_START` exists for the same reason.
 */
export function validStart(n) {
  return Number.isInteger(n) && n >= 0 && n <= MAX_ENTRY;
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
      if (!validStart(parsed.start)) {
        throw new TypeError(`start harus bilangan bulat 0–${MAX_ENTRY}`);
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
   * log's own well-formedness — that the union can express the row, that no id
   * in it names a player who is not at the table, and, at the penalty gate, that
   * a typed amount is one this app accepts.
   *
   * The split is deliberate. Which fields an event *must* carry is its contract
   * with settle.js, and settle.js already enforces it by throwing. Which ids
   * are *still valid* is a property of the state — it goes stale when the
   * roster changes or a file is imported — and only the store can see that.
   *
   * **Two deliberate exceptions, both at the penalty gate below.** First, a
   * `point` row's `fine` must be present and positive — `settle.js` would throw
   * on it anyway, but the store is the door that admits a hand-edited or imported
   * payload, and an unwritten rule is no rule at a door. Second, its **magnitude**
   * must be within `MAX_ENTRY`. Magnitude is a category this door has never
   * carried: every other check here asks whether a closed set can *express* a
   * value, or whether an id is still on the roster, and magnitude is neither.
   * Measured before the ceiling existed — `fine: 1e15` passed (`Number.isSafeInteger`
   * is true for it), loaded with `problem() === null`, left every balance wrong by
   * an astronomical amount, and still summed to exactly 0 with nothing flagged.
   *
   * All of it exists because the log is append-only: a row that cannot be read
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

    // The one deliberate exception to the split stated just above, and it is worth
    // naming as an exception rather than letting it look like a lapse.
    //
    // `settle.js` already refuses a `tay` or an `amount` that is not a positive
    // integer — it throws in `requirePositiveInt` — so the FLOOR belongs to it and is
    // deliberately not repeated here. What `settle.js` has no opinion about is
    // *magnitude*, and magnitude is exactly what a typed field gets wrong: a keypad
    // that admits one digit too many, or a number input handed `1e5`, produces a row
    // that is well-formed, prices cleanly, and quietly makes one hand worth more than
    // every other hand in the game. That is not a shape the event's contract can
    // express, so it is the store's to refuse.
    //
    // At the door rather than only at the keypad because the door is what admits a
    // hand-edited or imported payload — a keypad cannot stop a file. `typeof ===
    // "number"` rather than a bare `>` so that a missing or non-numeric field falls
    // through to settle.js's rule instead of being reported as a magnitude failure,
    // but a non-finite one does not: `Infinity > MAX_ENTRY` is true, and refusing it
    // here is the difference between a message and the silent death Tasks 7–9 each
    // closed for a different table.
    if (event.type === "hu" && typeof event.tay === "number" && event.tay > MAX_ENTRY) {
      throw new TypeError(`tay melebihi batas ${MAX_ENTRY}: ${JSON.stringify(event.tay)}`);
    }
    if (event.type === "utang" && typeof event.amount === "number" && event.amount > MAX_ENTRY) {
      throw new TypeError(`jumlah utang melebihi batas ${MAX_ENTRY}: ${JSON.stringify(event.amount)}`);
    }

    if (event.type === "penalty") {
      const row = PENALTY_ROWS.find((r) => r.no === event.row);
      if (!row) throw new TypeError(`baris penalti tidak dikenal: ${JSON.stringify(event.row)}`);

      // The required-field half of the check. A `point` row's amount is typed per
      // incident, so an absent or nonsensical `fine` makes the row unpriceable —
      // and by the rule this whole block follows, an unpriceable row poisons every
      // score after it and can never be taken back out.
      //
      // Note this is NOT the koin check's question. That one asks whether `KOIN`
      // can *express* the value; this one asks whether the value is there at all.
      // Shape is `settle.js`'s contract (it throws in `requirePositiveInt`), but
      // `fine` is needed by neither `settle.js` nor referential integrity, so it
      // is the store that must ask — the store is the door that admits a
      // hand-edited or imported payload, and an unwritten rule is no rule at a door.
      if (row.kind === "point" && !(Number.isSafeInteger(event.fine) && event.fine > 0 && event.fine <= MAX_ENTRY)) {
        throw new TypeError(
          `denda penalti baris ${row.no} harus bilangan bulat 1–${MAX_ENTRY}: ${JSON.stringify(event.fine)}`,
        );
      }
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
    if (!validStart(start)) {
      throw new TypeError(`start harus bilangan bulat 0–${MAX_ENTRY}, dapat: ${JSON.stringify(start)}`);
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
    if (!validStart(next.start)) throw new TypeError(`start harus bilangan bulat 0–${MAX_ENTRY}`);
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

  /**
   * The archive as stored: newest first, oldest already dropped at the cap.
   *
   * `[]` when there is no archive; `null` when the stored bytes are not a JSON
   * array — including a storage read that throws. A reader cannot tell those apart
   * and does not need to, so the distinction is handed back rather than collapsed
   * here, and each caller decides where it matters. Elements are the raw stored
   * strings, returned fresh from `JSON.parse` on every call, so no caller can alias
   * the stored archive or the array another caller holds.
   */
  function readArchive() {
    if (!backing) return [];
    let raw;
    try {
      raw = backing.getItem(ARCHIVE_KEY);
    } catch {
      // Storage broken rather than archive broken. The next write reports it — see
      // `archiveReset`, whose archive write is the first thing that follows a read.
      return null;
    }
    if (raw === null || raw === "") return [];
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    return Array.isArray(parsed) ? parsed : null;
  }

  /**
   * LAW 5's archive door: keep the game, then clear the table.
   *
   * Three steps, and the order is the whole point.
   *
   * 1. **Archive first**, from the raw stored string — never from `state`.
   * 2. **Unseal second.** `read()` marks a payload it could not parse or validate
   *    as sealed, and `save()` opens with `if (sealed) return false`. Without this
   *    the archive keeps the bytes, the write is refused, and the table still shows
   *    the old game under a corrupt banner: the worst of both outcomes.
   * 3. **Clear third**, then save.
   *
   * An archive write that throws — quota, storage revoked — leaves the store exactly
   * as it was, sealed and intact, because nothing after it has run yet. That is the
   * entire reason the archive write is first.
   *
   * `players` and `start` survive: a reset is "same table, new game", not "new
   * table". `createdAt` does not, because it dates *this* game. After a payload
   * `read()` could not parse there is no roster to preserve — `state` is the empty
   * state — so the roster comes back empty and setup opens. That is the honest
   * outcome for an unreadable roster, and it is what makes reset the one path a
   * player has to get out of a corrupt table.
   *
   * Returns the archived entry — the raw string — so a caller can report what was
   * kept without re-reading the archive.
   */
  function archiveReset() {
    const s = ensure();
    if (!backing) throw new TypeError(STORAGE_MESSAGES.unavailable);

    let raw;
    try {
      raw = backing.getItem(STORAGE_KEY);
    } catch {
      problem = "unavailable";
      throw new TypeError(STORAGE_MESSAGES.unavailable);
    }
    if (raw === null || raw === "") {
      // Keyed on the *stored string*, never on `events.length`. `read()` returns
      // `emptyState()` for a payload it cannot parse, so an events-based guard would
      // refuse on exactly the corrupt table this function exists to rescue.
      //
      // The two absences are not the same, though. An empty table has nothing worth
      // keeping. A table whose events exist in memory only — storage was wiped, or
      // never accepted a write — is the *only* copy of a real game, and protecting it
      // is what the refusal is for. Reporting that as "nothing archived" would send a
      // player looking for a table they can see on the screen in front of them.
      if (s.events.length > 0) throw new TypeError(STORAGE_MESSAGES.unavailable);
      throw new TypeError(ARCHIVE_MESSAGES.empty);
    }

    // `?? []`: an archive that cannot be read back is dropped rather than refused.
    // The opposite of what `read()` does with the game payload, deliberately. The
    // game is the only copy of playable state, so refusing to overwrite it keeps a
    // JSON fix possible. The archive holds games that were already retired, and bytes
    // nothing can parse cannot be read back by any path in this app — so refusing
    // here would trade unreadable garbage for a Reset control that never works again,
    // with no in-app way to clear it.
    const entries = [raw, ...(readArchive() ?? [])].slice(0, ARCHIVE_MAX);
    try {
      backing.setItem(ARCHIVE_KEY, JSON.stringify(entries));
    } catch {
      // Nothing after this line has run, so the store is still sealed and the log is
      // still intact. The archive is the one write in this module that has to be
      // all-or-nothing.
      problem = "unavailable";
      throw new TypeError(STORAGE_MESSAGES.unavailable);
    }

    // A confirmed reset whose bytes are already in the archive is the same class of
    // explicit act as an import, and gets the same answer `replace()` gives.
    sealed = false;
    s.events = []; // LAW 5 — archived, not deleted
    s.createdAt = now();
    // If this fails the banner says so and a reload brings the old game back off
    // disk, so nothing is lost either way: the archive already holds it.
    save();
    return raw;
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
    archiveReset,
    // Read-only, and a fresh array every call — the archive is only ever written
    // through `archiveReset`.
    archive: () => readArchive() ?? [],
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
