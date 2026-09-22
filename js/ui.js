// P3 scoring app — render and event wiring. The only module that touches the DOM.
//
// It reads state through store.js and prices it with settle.js, and does no
// arithmetic of its own. DECISIONS.md C1 makes that boundary load-bearing: a
// correction from the field test has to cost settle.js plus an `npm test` re-run,
// which stops being true the moment a score is computed here.

import { DEFAULT_START, FU_FLOOR_CITE, FU_FLOOR_TAY, HU_METHODS, KOIN, MAX_ENTRY, MIN_FU_TAY, PENALTY_ROWS, PING_FU_CITE, PING_FU_REMINDER } from "./rules.js";
import { ARCHIVE_MAX, SEATS, ackDisclaimer, disclaimerAcked, store, validStart } from "./store.js";
import { applyFuFloor, cancellations, scoresFrom, transfersFor } from "./settle.js";
import { EXPORT_MESSAGES, IMPORT_MESSAGES, ImportError, exportGame, importGame } from "./io.js";

/** The name shown for a seat. The compass letter N/E/S/W lives in index.html. */
const SEAT_LABEL = { tung: "Tung", nan: "Nan", si: "Si", pei: "Pei" };

/**
 * Wind order (Tung→Pei = E,S,W,N), which is `SEATS` itself, rather than the
 * diamond's compass order. Named once and used by both lists: the scoreboard and
 * the Selesai result list are two renderings of one roster, and two copies of this
 * comparator are two chances for them to disagree about who comes first.
 */
const windOrder = (a, b) => SEATS.indexOf(a.seat) - SEATS.indexOf(b.seat);

/**
 * How many digits the Hu keypad accepts, derived from the ceiling rather than written
 * as a second literal. It read `6` — 999999 tay, past any real hand — until Task 22 set
 * the ceiling at `MAX_ENTRY`, which made the six wrong by exactly the bound it was
 * standing in for: a pad admitting a fifth digit offers a number `store.validate`
 * refuses, so the player types it, taps Catat, and reads a rejection for a value the
 * app handed them the keys to.
 */
const MAX_TAY_DIGITS = String(MAX_ENTRY).length;

/**
 * How many digits the Penalti keypad accepts, derived from the ceiling itself
 * rather than written as a second literal. The pad and the door have to agree:
 * a pad that admits a fifth digit offers a number `store.validate` refuses, so
 * the player types it, taps Catat, and reads a rejection for a value the app
 * handed them the keys to. The Hu pad's cap above is derived from the same
 * constant for the same reason.
 */
const MAX_ENTRY_DIGITS = String(MAX_ENTRY).length;

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Table text is never locale-grouped: `Σ 1200`, never `Σ 1.200`. */
const fmt = (n) => String(n);

const show = (...els) => els.forEach((el) => (el.hidden = false));
const hide = (...els) => els.forEach((el) => (el.hidden = true));

let sheetPlayerId = null;

// ── views ────────────────────────────────────────────────────────────────────

function setView(name) {
  document.body.dataset.view = name;
  for (const b of $$(".tabbar button")) {
    b.setAttribute("aria-current", String(b.dataset.goto === name));
  }
}

// ── render ───────────────────────────────────────────────────────────────────

function renderBanner() {
  const msg = store.problemMessage();
  const el = $("#banner");
  el.hidden = !msg;
  if (msg) el.textContent = msg;
}

function renderTable() {
  const { players, events, start } = store.state();
  const scores = scoresFrom(events, players, start);
  let total = 0;

  for (const seat of SEATS) {
    const el = $(`.seat[data-seat="${seat}"]`);
    const p = players.find((x) => x.seat === seat);
    const skor = p ? (scores.get(p.id) ?? start) : 0;
    total += skor;

    el.dataset.player = p?.id ?? "";
    el.disabled = !p;
    $(".seat-nama", el).textContent = p ? p.name : "—";
    $(".seat-skor", el).textContent = p ? fmt(skor) : "—";
    el.setAttribute(
      "aria-label",
      p ? `${p.name}, ${SEAT_LABEL[seat]}, skor ${fmt(skor)}` : `Kursi ${SEAT_LABEL[seat]} kosong`,
    );
  }

  // n × start, where n is the number of players — not a literal 4 × a literal 300.
  // `start` is read from state everywhere; the only 300 in the app is in rules.js.
  const diharapkan = start * players.length;
  $("#plaque-total").textContent = fmt(total);
  $("#plaque").dataset.anomali = String(players.length > 0 && total !== diharapkan);
}

function render() {
  renderBanner();
  renderTable();
  renderSkor();
  renderSelesai();
}

// ── skor — the four-row board, then the log newest-first ─────────────────────
//
// Every number on this screen is priced by settle.js and read back out of its own
// output — never re-derived here (C1). The delta column is a sum over what
// `transfersFor()` returned: nothing in this section knows that a taCung discarder
// pays double, it adds up what the engine moved and names the player it moved to or
// from. That is what keeps this screen and the committed scores from disagreeing.

/** `+78` / `−26` / `0`. The sign is explicit so a gain cannot be misread as a loss. */
function fmtNet(n) {
  if (n > 0) return `+${n}`;
  // U+2212 MINUS SIGN, not a hyphen: this is a numeral, and it must line up in the
  // tabular column the way the digits do.
  if (n < 0) return `−${-n}`;
  return "0";
}

/**
 * What one event moved for the player it names, as the log currently stands.
 *
 * `null` — not `0` — for the two rows that move nothing, because a typed `0` would
 * claim a movement that did not happen. An `utang` never moved a score — a loan was
 * recorded, never priced — and a `koreksi` has no arithmetic of its own at all:
 * settle.js refuses to price one, which is why it is answered before `transfersFor`
 * is ever called.
 */
function eventDelta(event, players) {
  if (event.type === "koreksi") return null;
  const transfers = transfersFor(event, players);
  const sum = (pick) => transfers.filter(pick).reduce((s, t) => s + t.amount, 0);
  switch (event.type) {
    case "hu":      return sum((t) => t.to === event.winnerId);
    case "koin":    return sum((t) => t.to === event.collectorId);
    case "penalty": return -sum((t) => t.from === event.offenderId);
    case "utang":   return null;
    default:        return null;
  }
}

/**
 * One history line. Labels come from rules.js — no Hu method, koin combination or
 * penalty row is retyped here, so a rename in the tables reaches this list.
 *
 * Every event type is listed, `utang` included. The history is the log, and a log
 * view that drops rows cannot be checked against the scores beside it — worse, a
 * `koreksi` cancelling an invisible row would be a reference to nothing. No screen
 * adds loans any more (SPEC 3); a loan already in a log still renders here, and it
 * must, for the `koreksi` reason above.
 */
function eventText(event, seqOf) {
  const players = store.state().players;
  const of = (id) => players.find((x) => x.id === id);
  const seat = (id) => SEAT_LABEL[of(id)?.seat] ?? "—";
  const nama = (id) => of(id)?.name ?? "—";

  switch (event.type) {
    case "hu":
      return `${HU_METHODS[event.method].label} · ${seat(event.winnerId)} · ${event.tay} tay`;
    case "koin":
      return `Koin ${KOIN[event.kind].label} · ${seat(event.collectorId)} · ${KOIN[event.kind].amount} koin`;
    case "penalty": {
      const row = PENALTY_ROWS.find((r) => r.no === event.row);
      return `Penalti · ${nama(event.offenderId)}${row ? ` · ${row.name}` : ""}`;
    }
    case "utang":
      return `Utang · ${nama(event.borrowerId)} dari ${nama(event.lenderId)} · ${event.amount} poin`;
    case "koreksi":
      return `Koreksi #${seqOf(event.corrects) ?? "?"}`;
    default:
      return event.type;
  }
}

/**
 * Undo. A `koreksi` is appended; nothing is ever removed (LAW 5, SPEC.md rule 6).
 *
 * No confirm step, deliberately: the action is itself an event, so undoing the undo
 * puts the row back. A dialog guarding a reversible append-only action is friction
 * that protects nothing — and it would sit on the one control a player reaches for
 * mid-round.
 */
function appendKoreksi(targetId, errorSel = "#skor-error") {
  try {
    store.undo(targetId);
  } catch (e) {
    // The target came from the log as it stood at render time. If it has gone since
    // — a second tab's undo, or an import — say so rather than closing over the
    // failure and letting the tap read as success.
    //
    // The message goes to the caller's own error line rather than a fixed one: the
    // caller is the one that knows which screen the control sits on, and a failure
    // reported into another screen's line is a message the player will never see.
    const el = $(errorSel);
    el.hidden = false;
    el.textContent = e.message;
    return;
  }
  $(errorSel).hidden = true;
  render();
}

function renderSkor() {
  const { players, events, start } = store.state();
  const scores = scoresFrom(events, players, start);
  const cancelled = cancellations(events);
  const seqOf = (id) => events.find((e) => e.id === id)?.seq;

  // ── the board ──────────────────────────────────────────────────────────────
  // This is a list, and the table's geometry is a fact about the table, not about
  // a player — so wind order, not the diamond's compass order. See `windOrder`.
  const papan = $("#skor-papan");
  papan.replaceChildren();
  for (const p of [...players].sort(windOrder)) {
    const skor = scores.get(p.id) ?? start;
    const li = document.createElement("li");
    li.className = "papan-baris";

    const tile = document.createElement("img");
    tile.className = "tile";
    tile.src = `tiles/${p.seat}.svg`;
    tile.alt = SEAT_LABEL[p.seat] ?? "";

    const nama = document.createElement("span");
    nama.className = "papan-nama";
    nama.textContent = p.name;

    const angka = document.createElement("span");
    angka.className = "papan-skor";
    angka.textContent = fmt(skor);

    const net = document.createElement("span");
    net.className = "papan-net";
    // The sign alone is not speech. A screen reader hears "plus 12" as easily as
    // "12", so the word goes in a span only it reads.
    const sr = document.createElement("span");
    sr.className = "sr-only";
    sr.textContent = "selisih ";
    net.append(sr, document.createTextNode(fmtNet(skor - start)));

    li.append(tile, nama, angka, net);
    papan.append(li);
  }

  // Summed from the same map the rows were read from, so the footer cannot disagree
  // with the column above it. `n × start` — not a literal 4 × a literal 300.
  const total = [...scores.values()].reduce((s, v) => s + v, 0);
  const diharapkan = start * players.length;
  $("#skor-angka").textContent = fmt(total);
  $("#skor-harap").textContent = fmt(diharapkan);
  $("#skor-total").dataset.anomali = String(players.length > 0 && total !== diharapkan);

  // ── the log ────────────────────────────────────────────────────────────────
  const kosong = events.length === 0;
  $("#skor-kosong").hidden = !kosong;
  $("#skor-riwayat").hidden = kosong;

  const riwayat = $("#skor-riwayat");
  riwayat.replaceChildren();
  // Newest first, by array order rather than by `seq`: `seq` is monotonic but an
  // imported log need not be contiguous, and array order is what `resolveEvents`
  // walks — so this list and the arithmetic cannot disagree about which koreksi is
  // the later one.
  for (const event of [...events].reverse()) {
    const nonaktif = cancelled.has(event.id);
    const li = document.createElement("li");
    li.className = "riwayat-baris";
    li.dataset.nonaktif = String(nonaktif);

    const seq = document.createElement("span");
    seq.className = "riwayat-seq";
    seq.textContent = `#${event.seq}`;

    const isi = document.createElement("span");
    isi.className = "riwayat-isi";
    isi.textContent = eventText(event, seqOf);

    const d = eventDelta(event, players);
    const delta = document.createElement("span");
    delta.className = "riwayat-delta";
    delta.textContent = d === null ? "—" : fmtNet(d);

    // The target is the *active* koreksi when this row is already cancelled, not the
    // row itself. Targeting the row appends a second koreksi pointing at the same
    // event, which leaves it cancelled — a row appears and nothing moves. Measured
    // against `resolveEvents` before this was written; see `cancellations`.
    const target = cancelled.get(event.id) ?? event.id;
    const aksi = document.createElement("button");
    aksi.type = "button";
    aksi.className = "riwayat-aksi";
    aksi.textContent = nonaktif ? "Pulihkan" : "Batalkan";
    aksi.setAttribute("aria-label", `${aksi.textContent} #${event.seq}`);
    aksi.addEventListener("click", () => appendKoreksi(target));

    li.append(seq, isi, delta, aksi);
    riwayat.append(li);
  }
}

// ── selesai — hasil permainan, and the archive door ───────────────────────────
//
// What each player won at the table, rendered straight from `scoresFrom` — nothing
// here is arithmetic (C1).
//
// Two blocks used to sit above the archive door: the loan ledger, and the transfer
// list that ended the night. SPEC 3 removed both, so the heading inside carries no
// numeral — one section is not a sequence.

function renderSelesai() {
  const { players, events, start } = store.state();
  const scores = scoresFrom(events, players, start);
  const roster = [...players].sort(windOrder);
  const kosong = events.length === 0;

  // ── Hasil permainan — what each player won at the table ────────────────────
  const hasil = $("#selesai-hasil");
  hasil.replaceChildren();
  for (const p of roster) {
    const skor = scores.get(p.id) ?? start;
    const li = document.createElement("li");
    li.className = "papan-baris";

    const n = document.createElement("span");
    n.className = "papan-nama";
    n.textContent = p.name;

    const s = document.createElement("span");
    s.className = "papan-skor";
    s.textContent = fmt(skor);

    const net = document.createElement("span");
    net.className = "papan-net";
    const sr = document.createElement("span");
    sr.className = "sr-only";
    sr.textContent = "selisih ";
    net.append(sr, document.createTextNode(fmtNet(skor - start)));

    li.append(n, s, net);
    hasil.append(li);
  }

  $("#selesai-kosong").hidden = !kosong;

  // The archive door, hidden with the log it would archive. SPEC 2 §1 hides "the
  // control"; the whole block goes, because the sentence above the button describes
  // what archiving does and would otherwise describe an act that cannot be taken,
  // directly over "Belum ada catatan" and saying the same thing twice.
  $("#selesai-arsip").hidden = kosong;
  // An open confirm is dropped on every render, because its sentence counts the live
  // log and stops being true the moment an event lands. A confirm still naming 12
  // catatan over a log of 13 is the app asking about a table that no longer exists.
  closeResetConfirm();
}

// ── reset — the archive door in `#view-selesai` ──────────────────────────────

function setResetError(msg) {
  const el = $("#reset-error");
  el.hidden = !msg;
  el.textContent = msg ?? "";
}

/**
 * What the confirm says, counted off the live log at the moment it is asked — the
 * same rule `ioLossText` follows, and for the same reason: a sentence built here can
 * never describe a table other than the one on screen.
 */
function resetConfirmText() {
  const { events, players } = store.state();
  const text = `Arsipkan ${fmt(events.length)} catatan dari ${fmt(players.length)} pemain, lalu mulai permainan baru?`;
  // At the cap every further reset silently drops the oldest entry, so the confirm
  // says so *before* the tap. 21 resets in one night is plausible on this app's own
  // premise — one phone, four players, no server — and an unannounced truncation
  // satisfies LAW 5's "expiry = archive, not delete" only until the 21st reset.
  return store.archive().length >= ARCHIVE_MAX
    ? `${text} Arsip penuh — permainan terlama akan dihapus.`
    : text;
}

function openResetConfirm() {
  setResetError(null);
  $("#reset-tanya").textContent = resetConfirmText();
  const box = $("#reset-konfirmasi");
  box.hidden = false;
  // The confirm lands at the tail of a stack that can outgrow the column, and
  // `#view-selesai` scrolls rather than pushes — so on a 664px-tall phone the two
  // buttons opened 32px behind the fixed tabbar. A confirm the player has to go
  // looking for is not a confirm; bring it into the scroll viewport on open.
  // `nearest` scrolls the minimum, so a confirm already fully visible stays put.
  box.scrollIntoView({ block: "nearest" });
}

function closeResetConfirm() {
  $("#reset-konfirmasi").hidden = true;
  $("#reset-tanya").textContent = "";
}

/**
 * The confirmed reset. The refusal is already a Bahasa sentence — `ARCHIVE_MESSAGES`
 * or a storage message — so it is shown as-is, the same contract `confirmImport`
 * has, minus the `ImportError` wrapper because there is no file to report on.
 */
function commitReset() {
  closeResetConfirm();
  try {
    store.archiveReset();
  } catch (e) {
    setResetError(e.message);
    render();
    return;
  }
  setResetError(null);
  render();
  // A reset leaves the player on Selesai showing "Belum ada catatan. Ketuk nama
  // pemain untuk mulai." — an invitation to a tap this screen cannot receive. The
  // next act of a new game happens on the table, so the table is where it lands.
  setView("meja");
}

// ── setup — a first-run sheet over meja, not a fifth view ────────────────────

function setSetupError(msg) {
  const el = $("#setup-error");
  el.hidden = !msg;
  el.textContent = msg ?? "";
}

function openSetup() {
  const { players, start } = store.state();
  $$("#setup-form .peserta").forEach((row, i) => {
    const p = players[i];
    $("input", row).value = p?.name ?? "";
    $("select", row).value = p?.seat ?? SEATS[i];
  });
  $("#setup-start").value = fmt(start ?? DEFAULT_START);
  setSetupError(null);
  // The archive area resets with the form: a refusal left over from a file chosen
  // last time describes a table the player has since left, and a pending confirm
  // would name a log that is no longer the one on screen.
  setIoError(null);
  closeIoConfirm();
  show($("#setup"), $("#scrim"));
}

function submitSetup(ev) {
  ev.preventDefault();
  const rows = $$("#setup-form .peserta");
  const existing = store.state().players;
  const names = rows.map((r) => $("input", r).value.trim());
  const seats = rows.map((r) => $("select", r).value);
  const start = Number($("#setup-start").value);

  if (names.some((n) => n === "")) return setSetupError("Isi nama keempat pemain.");
  if (new Set(seats).size !== SEATS.length) return setSetupError("Setiap pemain harus dapat kursi yang berbeda.");
  if (!validStart(start)) return setSetupError(`Modal awal harus bilangan bulat 0–${MAX_ENTRY}.`);

  try {
    // Ids are carried over by position, so re-running setup to fix a typo does not
    // orphan the events already in the log (store.setPlayers, Task 3).
    store.setStart(start);
    store.setPlayers(rows.map((_, i) => ({ id: existing[i]?.id, name: names[i], seat: seats[i] })));
  } catch (e) {
    return setSetupError(e.message);
  }

  hide($("#setup"), $("#scrim"));
  render();
}

// ── arsip — export the log, import one back ──────────────────────────────────
//
// Export is the archive path (LAW 5), and the safety net for the storage failure
// store.js reports as `corrupt` — the one failure a player can recover from
// without losing the night's game.
//
// Import is the sharp end: it is the only door in this app that throws away a live
// log. So the flow is deliberately three steps with a stop between the second and
// third — read the file, say out loud what is about to be replaced, and only then
// write. `importGame` reads and returns; nothing is stored until `#io-ya`.

/** The payload from a file that cleared io.js, waiting on the confirm. */
let pendingImport = null;

function setIoError(msg) {
  const el = $("#io-error");
  el.hidden = !msg;
  el.textContent = msg ?? "";
}

/**
 * What the confirm says, built from the live log at the moment it is asked.
 *
 * A confirm reading only "replace your data?" is a dialog a player taps through;
 * the sentence that makes them stop is the one naming what they are about to lose.
 * Built here rather than written into index.html so it can never describe a table
 * other than the one on screen — measured: the same file is as often the wrong one
 * as the right one, and the player is the only one who can tell.
 */
function ioLossText() {
  const { events, players } = store.state();
  const nama = players.map((p) => p.name).join(", ");
  if (events.length === 0 && players.length === 0) {
    return "Belum ada catatan di meja ini, jadi impor tidak menghilangkan apa pun. Lanjut?";
  }
  if (events.length === 0) {
    return `Meja ini belum punya kejadian, tapi nama dan modal pemainnya (${nama}) akan digantikan. Lanjut?`;
  }
  return `Impor menggantikan catatan sekarang — ${fmt(events.length)} kejadian untuk ${nama}. Lanjut?`;
}

/**
 * Drop the pending payload and shut the confirm. Also clears the file input:
 * choosing the *same* file twice fires no `change` event, so a player who cancels
 * and immediately re-picks the file they just picked would see nothing happen.
 */
function closeIoConfirm() {
  pendingImport = null;
  $("#io-konfirmasi").hidden = true;
  $("#io-tanya").textContent = "";
  $("#io-file").value = "";
}

/** Nothing typed into #io-file is a choice; a chosen file is a question. */
async function chooseImportFile(ev) {
  const file = ev.target.files?.[0];
  if (!file) return;
  setIoError(null);
  let payload;
  try {
    payload = await importGame(file);
  } catch (e) {
    // io.js throws ImportError with a message already fit for the screen; anything
    // else (a File whose text() is unimplemented, say) is still a file we cannot
    // use, and saying so beats an uncaught rejection with no console on a phone.
    closeIoConfirm();
    return setIoError(e instanceof ImportError ? e.message : IMPORT_MESSAGES.unreadable);
  }
  pendingImport = payload;
  $("#io-tanya").textContent = ioLossText();
  $("#io-konfirmasi").hidden = false;
}

function confirmImport() {
  if (!pendingImport) return closeIoConfirm();
  try {
    // replace() re-validates every player and every event against the rules, so a
    // file that cleared io.js's two gates can still be refused here — the gates
    // there are about the file, and this one is about the game.
    store.replace(pendingImport);
  } catch {
    closeIoConfirm();
    return setIoError(IMPORT_MESSAGES.replaceFailed);
  }
  closeIoConfirm();
  setSetupError(null);
  hide($("#setup"), $("#scrim"));
  render();
}

function doExport() {
  setIoError(null);
  // Deliberately does NOT drop a pending import: backing up the current log before
  // replacing it is the safe move, and the confirm's sentence is still true after
  // an export because an export writes nothing.
  try {
    exportGame();
  } catch {
    setIoError(EXPORT_MESSAGES.failed);
  }
}

// ── action sheet ─────────────────────────────────────────────────────────────

function openSheet(playerId) {
  const p = store.state().players.find((x) => x.id === playerId);
  if (!p) return;
  sheetPlayerId = playerId;
  $("#sheet-who").textContent = p.name;
  show($("#sheet"), $("#scrim"));
}

/** Setup outlives the action sheet, so the scrim goes only once both are shut. */
function closeSheets() {
  sheetPlayerId = null;
  hide($("#sheet"));
  hideScrimIfClear();
}

/**
 * The notice has one exit, and it is `Mengerti` — no scrim tap, no Escape, no
 * back-out. Acknowledging is not a preference the app offers; it is the condition
 * for the app being the kind of app it says it is.
 *
 * The ack is written **first**, so a throw out of `openSetup` cannot leave a player
 * who has read the notice facing it again on the next open — the acknowledgment is
 * about this device, and it is true the moment it is given.
 *
 * The branch is not "open setup": a complete table is a player who has already
 * started, and they should land on their game rather than on a roster they filled
 * in weeks ago. That case is reachable by clearing site data on a phone mid-game.
 */
function ackAndContinue() {
  ackDisclaimer();
  hide($("#disclaimer"));
  if (store.state().players.length !== SEATS.length) openSetup();
  else hideScrimIfClear();
}

/**
 * One scrim is shared by five overlays — first-run setup, the action sheet, the Hu
 * flow, the penalty flow and the first-open notice. It is dismissed only when the
 * last of them has gone, so handing over from one to the next never flashes the
 * table through.
 *
 * The notice is in this condition even though it is the one overlay that cannot be
 * dismissed by a scrim tap: this is the app's statement of *when every overlay is
 * shut*, and a fifth overlay the condition did not know about would make that
 * statement false. The failure it produces is a notice floating over an undimmed
 * table.
 */
function hideScrimIfClear() {
  if ($("#setup").hidden && $("#sheet").hidden && $("#hu").hidden && $("#penalti").hidden && $("#koin").hidden && $("#disclaimer").hidden) hide($("#scrim"));
}

// ── hu — method → (discarder) → tay → preview → commit ───────────────────────

/** The entry in progress, or null. Nothing is written until Catat. */
let hu = null;

function huStep(step) {
  $("#hu").dataset.huStep = step;
  for (const el of $$("#hu .hu-panel")) el.hidden = el.dataset.huStep !== step;
}

/** The typed digits as a positive integer, or null while they are not one yet. */
function huTay() {
  if (hu.digits === "") return null;
  const n = Number(hu.digits);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * The event this flow would append, or null while the entry is incomplete.
 * Built here, priced by settle.js — never the other way round.
 */
function huEvent() {
  const tay = huTay();
  if (tay === null) return null;
  const event = { type: "hu", method: hu.method, tay: applyFuFloor(tay), winnerId: hu.winnerId };
  // A self-draw has no discarder at all; settle.js reads the absence, so the key
  // is omitted rather than set to null (store.js skips null ids, which would
  // silently accept a taCung win with nobody to charge).
  if (!HU_METHODS[hu.method].selfDraw) event.discarderId = hu.discarderId;
  return event;
}

/**
 * The preview line, rendered from what `transfersFor()` returned.
 *
 * The totals below are a sum over the engine's own output, not a second copy of
 * the rule: nothing here knows that a taCung discarder pays double — it reads
 * the largest share the engine produced and calls it the doubled one. That is
 * what keeps this string and the committed score from ever disagreeing (C1).
 */
function huPreviewText(transfers, method) {
  const total = transfers.reduce((sum, t) => sum + t.amount, 0);
  if (method.selfDraw) {
    return `3 pemain lain bayar 2× (${transfers[0].amount}) · pemenang terima ${total}`;
  }
  const amounts = transfers.map((t) => t.amount);
  return `Ta Cung bayar 2× (${Math.max(...amounts)}) · 2 pemain lain bayar ${Math.min(...amounts)} · pemenang terima ${total}`;
}

function renderHuMethods() {
  const box = $("#hu-methods");
  box.replaceChildren();
  for (const [key, method] of Object.entries(HU_METHODS)) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "hu-item";
    btn.dataset.method = key;
    const label = document.createElement("span");
    label.textContent = method.label;
    const cite = document.createElement("span");
    cite.className = "cite";
    cite.textContent = method.cite;
    btn.append(label, cite);
    btn.addEventListener("click", () => pickHuMethod(key));
    box.append(btn);
  }
}

/** The three players who are not the winner. A winner cannot discard to himself. */
function renderHuDiscarders() {
  const box = $("#hu-discarders");
  box.replaceChildren();
  for (const p of store.state().players) {
    if (p.id === hu.winnerId) continue;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "hu-item";
    btn.dataset.discarder = p.id;
    const label = document.createElement("span");
    label.textContent = p.name;
    const cite = document.createElement("span");
    cite.className = "cite";
    cite.textContent = SEAT_LABEL[p.seat];
    btn.append(label, cite);
    btn.addEventListener("click", () => {
      hu.discarderId = p.id;
      huStep("tay");
      renderHuTay();
    });
    box.append(btn);
  }
}

function pickHuMethod(key) {
  hu.method = key;
  if (HU_METHODS[key].selfDraw) {
    huStep("tay");
    return renderHuTay();
  }
  renderHuDiscarders();
  huStep("buang");
}

function renderHuTay() {
  // A null flow renders the empty panel rather than throwing. `closeHu()` empties the
  // panel as the flow ends and has no flow to hand over, and a renderer that can only
  // be called with a live flow is one refactor away from the crash this file already
  // carries a guard for in `commitHu`.
  const method = hu ? HU_METHODS[hu.method] : null;

  // A fresh flow renders before any method is picked, and `openHu` calls this so the
  // panel never holds the previous hand's numbers. They would be hidden at that point
  // — the tay panel is not the visible one — but a hidden panel carrying a stale tay
  // and its stale preview is one navigation away from being shown, and it reads as if
  // the player had already typed something.
  if (!method) {
    $("#hu-tay").textContent = "—";
    $("#hu-metode").textContent = "";
    $("#hu-preview").textContent = "";
    $("#hu-reminder").textContent = "";
    $("#hu-floor").hidden = true;
    $("#hu-error").hidden = true;
    $("#hu-commit").disabled = true;
    return;
  }

  const tay = huTay();
  $("#hu-tay").textContent = hu.digits === "" ? "—" : hu.digits;

  // YDSP P8/P9. Written here, beside the number it changes, because these two rows
  // are the ones the app cannot apply itself — it never sees the tiles, so it can
  // neither detect the ciok nor adjust the tay. The player reads the rule and types
  // the corrected number; the number pad is the whole mechanism.
  $("#hu-reminder").textContent = `${PING_FU_REMINDER} (${PING_FU_CITE})`;

  // The tay step names what is being recorded. The preview cannot do this job for
  // the five self-draw methods: they collapse to one identical string, so without
  // this line a tap on Thien Hu looks exactly like a tap on Pyong Pi and the
  // player has nothing to confirm the method registered. Rendered from
  // HU_METHODS like every other label, never restated here.
  let metode = method.label;
  if (!method.selfDraw) {
    const discarder = store.state().players.find((p) => p.id === hu.discarderId);
    if (discarder) metode += ` — ${discarder.name} buang`;
  }
  $("#hu-metode").textContent = metode;

  // Empty is an invitation, not a failure (SPEC.md rule 7) — nothing is shown
  // until something has been typed, and the message is for a typed non-positive.
  const err = hu.digits !== "" && tay === null ? "Masukkan angka lebih dari 0." : null;
  const errEl = $("#hu-error");
  errEl.hidden = !err;
  errEl.textContent = err ?? "";

  const floorEl = $("#hu-floor");
  let preview = "";
  if (tay !== null) {
    const event = huEvent();
    preview = huPreviewText(transfersFor(event, store.state().players), HU_METHODS[hu.method]);
    const floored = applyFuFloor(tay) !== tay;
    floorEl.hidden = !floored;
    if (floored) {
      // The numbers and the citation come from rules.js, so this sentence cannot
      // drift away from the floor it is describing.
      floorEl.textContent =
        `Fu kurang dari ${MIN_FU_TAY} — diselesaikan sebagai ${FU_FLOOR_TAY} tay (${FU_FLOOR_CITE})`;
    }
  } else {
    floorEl.hidden = true;
  }
  $("#hu-preview").textContent = preview;
  $("#hu-commit").disabled = tay === null;
}

function pressHuKey(key) {
  if (key === "back") {
    hu.digits = hu.digits.slice(0, -1);
  } else if (hu.digits.length < MAX_TAY_DIGITS) {
    // Leading zeros are stripped as they are typed, so `0` then `1` reads `1`,
    // and a lone `0` stays `0` so the error message has something to name.
    hu.digits = (hu.digits + key).replace(/^0+(?=\d)/, "");
  }
  renderHuTay();
}

function openHu(winnerId) {
  const p = store.state().players.find((x) => x.id === winnerId);
  if (!p) return closeSheets();
  hu = { winnerId, method: null, discarderId: null, digits: "" };
  $("#hu-who").textContent = p.name;
  renderHuMethods();
  // Both of the flow's other panels were emptied by `closeHu()`, so there is nothing
  // to clear here — the discarder list is built at the taCung pick, and the tay panel
  // was reset on the way out of the last flow.
  closeSheets(); // the action sheet hands over — never two scrims, never two dialogs
  huStep("metode");
  show($("#hu"), $("#scrim"));
}

function closeHu() {
  hu = null;
  // A closed dialog keeps nothing. The tay panel and the discarder list are emptied
  // as the flow ends, not when the next one opens — both are `hidden` at this point,
  // which is exactly why it has to be explicit: an unseen field still holding the last
  // hand's number reads as a pre-filled answer the moment anything navigates back to
  // it. Every exit runs through here — commit, Escape, scrim, Batal — so this is the
  // one place the reset belongs.
  renderHuTay();
  $("#hu-discarders").replaceChildren();
  hide($("#hu"));
  hideScrimIfClear();
}

function commitHu() {
  // Reachable with `hu` already null: `HTMLElement.click()` fires the handler whatever
  // the element's visibility, so a second activation of Catat — a stray script call, or
  // a keyboard path added later — runs this with no flow in progress. `pressHuKey` has
  // carried the same guard all along; the commit path is the one place it matters most,
  // since the next line writes to a log nothing can be removed from.
  if (!hu) return;
  const event = huEvent();
  if (!event) return;
  try {
    store.append(event);
  } catch (e) {
    // Stay open and say so. An append that threw recorded nothing, so closing
    // here would read as success and lose the hand silently.
    const errEl = $("#hu-error");
    errEl.hidden = false;
    errEl.textContent = e.message;
    return;
  }
  closeHu();
  setView("meja");
  render();
}

// ── penalti — pick a YDSP row, then Catat ────────────────────────────────────
//
// Two kinds of row, and which one is picked decides the rest of the flow. A
// `lewFit` row moves nothing: `settle.js` prices it at zero and the row itself is
// the whole record, so there is no number to type and no pad. A `point` row (rows
// 5 and 6) makes the offender pay a fine to each other player, and YDSP states no
// amount for either — so the amount is typed per incident, and the pad is the
// mechanism, exactly as the Hu flow's tay pad is. The rows that are already priced
// elsewhere are not offered at all; see `PENALTY_EXCLUDED` for which, and why.

/** The row picked in the open flow, or null. */
let penalti = null;

/** The typed fine as a positive integer, or null while it is not one yet. */
function penaltiFine() {
  if (!penalti || penalti.digits === "") return null;
  const n = Number(penalti.digits);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function penaltiEvent() {
  if (!penalti) return null;
  const event = { type: "penalty", kind: penalti.kind, row: penalti.row, offenderId: penalti.offenderId };
  // `fine` travels only on a `point` row. A `lewFit` event carrying one would be a
  // field nothing prices — `settle.js` reads `fine` on the point branch alone — and
  // the log is append-only, so a meaningless field on a real row is permanent.
  if (penalti.kind === "point") event.fine = penaltiFine();
  return event;
}

function renderPenaltiRows() {
  const box = $("#penalti-rows");
  box.replaceChildren();
  for (const row of PENALTY_ROWS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "hu-item";
    btn.dataset.penaltiRow = String(row.no);
    btn.setAttribute("aria-pressed", String(penalti?.row === row.no));
    const label = document.createElement("span");
    label.textContent = row.name;
    const cite = document.createElement("span");
    cite.className = "cite";
    cite.textContent = `YDSP P${row.no}`;
    btn.append(label, cite);
    // The consequence text sits under the name rather than in a second list, so the
    // row and what it costs cannot be read apart from each other.
    const desc = document.createElement("span");
    desc.className = "hu-item-desc";
    desc.textContent = row.desc;
    btn.append(desc);
    btn.addEventListener("click", () => pickPenaltiRow(row));
    box.append(btn);
  }
}

/**
 * The typed amount and the Catat button, in one place.
 *
 * Both are decided by the same question — is this row recordable yet? — so they
 * are rendered together. Splitting them is how a `point` row ends up with a fine
 * on screen and an enabled button, or the reverse: a pad the player can type into
 * while Catat stays shut with nothing saying why.
 */
function renderPenaltiFine() {
  const fine = penaltiFine();
  $("#penalti-fine-nilai").textContent = penalti?.digits === "" || penalti?.digits == null ? "—" : penalti.digits;
  // Three states, one expression: nothing picked yet is shut, a `lewFit` row needs no
  // amount and opens immediately, and a `point` row waits for a typed one. Rendered
  // from the `null` rather than from the digit string, so a lone `0` keeps Catat shut
  // — it is not a fine, and the door refuses it too.
  $("#penalti-commit").disabled = !penalti || penalti.row === null || (penalti.kind === "point" && fine === null);
}

function pickPenaltiRow(row) {
  // `digits` is reset on every pick, including point → point. The amount belongs to
  // the row that was picked, so carrying one across a row change would pre-fill the
  // next penalty with the last one's number and leave it looking already answered.
  penalti = { offenderId: penalti.offenderId, row: row.no, kind: row.kind, digits: "" };
  for (const b of $$("#penalti-rows [data-penalti-row]")) {
    b.setAttribute("aria-pressed", String(b.dataset.penaltiRow === String(row.no)));
  }
  // The pad appears only where there is a number to type. A `lewFit` row showing an
  // amount field would ask for something the row has no use for, and — because the
  // row moves nothing — the number would never appear in any balance afterwards.
  $("#penalti-fine").hidden = row.kind !== "point";
  renderPenaltiFine();
}

function pressPenaltiKey(key) {
  if (!penalti) return;
  if (key === "back") {
    penalti.digits = penalti.digits.slice(0, -1);
  } else if (penalti.digits.length < MAX_ENTRY_DIGITS) {
    // The same leading-zero rule as the Hu pad, so the two keypads cannot disagree
    // about what `0` then `1` is.
    penalti.digits = (penalti.digits + key).replace(/^0+(?=\d)/, "");
  }
  renderPenaltiFine();
}

function setPenaltiError(msg) {
  const el = $("#penalti-error");
  el.hidden = !msg;
  el.textContent = msg ?? "";
}

function openPenalti(offenderId) {
  const p = store.state().players.find((x) => x.id === offenderId);
  if (!p) return closeSheets();
  penalti = { offenderId, row: null, kind: null, digits: "" };
  $("#penalti-who").textContent = p.name;
  setPenaltiError(null);
  // No row is picked yet, so the pad is away and Catat is shut — a row is a real
  // choice with a consequence, and the flow must not commit by itself. Both come
  // from `renderPenaltiFine`, which is the one place that decides them; setting
  // `disabled` again here would be a second decider that has to keep agreeing.
  $("#penalti-fine").hidden = true;
  renderPenaltiFine();
  renderPenaltiRows();
  closeSheets(); // the action sheet hands over — never two scrims, never two dialogs
  show($("#penalti"), $("#scrim"));
}

function closePenalti() {
  penalti = null;
  // Emptied on the way out, like the Hu flow: every exit runs through here, so this
  // is the one place the reset belongs, and a closed dialog keeps nothing.
  $("#penalti-rows").replaceChildren();
  // The pad goes with the rows. It is `hidden` here rather than left showing for the
  // same reason the Hu tay panel is emptied: an unseen field still holding the last
  // fine reads as a pre-filled answer the moment anything navigates back to it.
  $("#penalti-fine-nilai").textContent = "—";
  $("#penalti-fine").hidden = true;
  setPenaltiError(null);
  hide($("#penalti"));
  hideScrimIfClear();
}

function commitPenalti() {
  // Guarded for the same reason `commitHu` is: `HTMLElement.click()` fires the
  // handler whatever the element's visibility, so a stray or keyboard activation
  // reaches this with no flow in progress — and this path writes to a log nothing
  // can be removed from.
  if (!penalti) return;
  const event = penaltiEvent();
  if (!event) return;
  try {
    store.append(event);
  } catch (e) {
    // Stay open and say so. An append that threw recorded nothing, so closing here
    // would read as success and lose the penalty silently.
    return setPenaltiError(e.message);
  }
  closePenalti();
  setView("meja");
  render();
}

// ── koin — pick a combination, then Catat ────────────────────────────────────
//
// Kong and flowers are paid in coins at the table and never enter tay, which is
// why this is a fourth flow rather than a line on the Hu sheet. The collector is
// the seat that was tapped (SPEC.md rule 3), so there is no "who collects?" step.
//
// No citation on these rows, unlike the Hu methods and the penalty rows: YDSP has
// no numbered row for koin — DECISIONS.md records the booklet's own game-flow
// module as the source — and printing an internal filename in a player-facing
// sheet is provenance theatre. The right-hand slot carries the amount instead,
// which is what the tap is for.

/** The combination picked in the open flow, or null. */
let koin = null;

function koinEvent() {
  if (!koin) return null;
  return { type: "koin", kind: koin.kind, collectorId: koin.collectorId };
}

function renderKoinRows() {
  const box = $("#koin-rows");
  box.replaceChildren();
  for (const [kind, row] of Object.entries(KOIN)) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "hu-item";
    btn.dataset.koinKind = kind;
    btn.setAttribute("aria-pressed", String(koin?.kind === kind));
    const label = document.createElement("span");
    label.textContent = row.label;
    const amount = document.createElement("span");
    amount.className = "koin-amount";
    amount.textContent = `${row.amount} koin`;
    btn.append(label, amount);
    btn.addEventListener("click", () => pickKoinRow(kind));
    box.append(btn);
  }
}

function pickKoinRow(kind) {
  koin = { collectorId: koin.collectorId, kind };
  for (const b of $$("#koin-rows [data-koin-kind]")) {
    b.setAttribute("aria-pressed", String(b.dataset.koinKind === kind));
  }
  $("#koin-commit").disabled = false;
}

function setKoinError(msg) {
  const el = $("#koin-error");
  el.hidden = !msg;
  el.textContent = msg ?? "";
}

function openKoin(collectorId) {
  const p = store.state().players.find((x) => x.id === collectorId);
  if (!p) return closeSheets();
  koin = { collectorId, kind: null };
  $("#koin-who").textContent = p.name;
  setKoinError(null);
  $("#koin-commit").disabled = true;
  renderKoinRows();
  closeSheets(); // the action sheet hands over — never two scrims, never two dialogs
  show($("#koin"), $("#scrim"));
}

function closeKoin() {
  koin = null;
  // Emptied on the way out, like the other two flows: every exit runs through here,
  // so this is the one place the reset belongs, and a closed dialog keeps nothing.
  $("#koin-rows").replaceChildren();
  setKoinError(null);
  hide($("#koin"));
  hideScrimIfClear();
}

function commitKoin() {
  // Guarded for the same reason `commitHu` and `commitPenalti` are: `HTMLElement.click()`
  // fires the handler whatever the element's visibility, and this path writes to a log
  // nothing can be removed from.
  if (!koin) return;
  const event = koinEvent();
  if (!event) return;
  try {
    store.append(event);
  } catch (e) {
    // Stay open and say so. An append that threw recorded nothing, so closing here
    // would read as success and lose the koin silently.
    return setKoinError(e.message);
  }
  closeKoin();
  setView("meja");
  render();
}

// ── wiring ───────────────────────────────────────────────────────────────────

function wire() {
  for (const b of $$(".tabbar button")) {
    b.addEventListener("click", () => setView(b.dataset.goto));
  }

  // A seat is the tap target, and it carries the id it was rendered for.
  for (const el of $$(".seat")) {
    el.addEventListener("click", () => openSheet(el.dataset.player));
  }

  for (const b of $$("#sheet [data-action]")) {
    b.addEventListener("click", () => {
      if (b.dataset.action === "hu") return openHu(sheetPlayerId);
      if (b.dataset.action === "penalti") return openPenalti(sheetPlayerId);
      if (b.dataset.action === "koin") return openKoin(sheetPlayerId);
      closeSheets();
    });
  }

  // Delegated, so eleven keys need one listener rather than eleven.
  $("#hu-keypad").addEventListener("click", (e) => {
    const key = e.target.closest("[data-key]");
    if (key && hu) pressHuKey(key.dataset.key);
  });
  $("#hu-commit").addEventListener("click", commitHu);
  for (const b of $$("[data-hu-cancel]")) b.addEventListener("click", closeHu);

  // Delegated, like the Hu pad's — same eleven keys, one listener.
  $("#penalti-keypad").addEventListener("click", (e) => {
    const key = e.target.closest("[data-key]");
    if (key && penalti) pressPenaltiKey(key.dataset.key);
  });
  $("#penalti-commit").addEventListener("click", commitPenalti);
  for (const b of $$("[data-penalti-cancel]")) b.addEventListener("click", closePenalti);

  $("#koin-commit").addEventListener("click", commitKoin);
  for (const b of $$("[data-koin-cancel]")) b.addEventListener("click", closeKoin);

  $("#disclaimer-mengerti").addEventListener("click", ackAndContinue);

  $("#scrim").addEventListener("click", () => {
    // First, and ahead of every other check: the notice is the one overlay a scrim
    // tap may not dismiss, and a dismissal that skips the acknowledgment defeats
    // the acknowledgment.
    if (!$("#disclaimer").hidden) return;
    if (hu) return closeHu();
    if (penalti) return closePenalti();
    if (koin) return closeKoin();
    closeSheets();
  });
  $("#btn-setup").addEventListener("click", openSetup);
  $("#setup-form").addEventListener("submit", submitSetup);

  $("#io-export").addEventListener("click", doExport);
  $("#io-import").addEventListener("click", () => {
    // #io-import is a plain button, not the file input: the input is the hidden
    // one `chooseImportFile` reads, and it is re-clicked through here so the whole
    // block stays one row of two same-sized buttons on a phone.
    setIoError(null);
    closeIoConfirm();
    $("#io-file").click();
  });
  $("#io-file").addEventListener("change", chooseImportFile);
  $("#io-ya").addEventListener("click", confirmImport);
  $("#io-batal").addEventListener("click", closeIoConfirm);

  $("#selesai-reset").addEventListener("click", openResetConfirm);
  $("#reset-ya").addEventListener("click", commitReset);
  $("#reset-batal").addEventListener("click", closeResetConfirm);

  // A refusal explains the state the form was in when it was refused, so it stops
  // being true the moment the player edits the form: "Isi nama keempat pemain." is
  // still up while the fourth name is being typed, describing a state already left
  // behind. Delegated, so every field clears it without the setter having to be wired
  // per input.
  for (const [form, clear] of [
    [$("#setup-form"), () => setSetupError(null)],
  ]) {
    form.addEventListener("input", clear);
    form.addEventListener("change", clear);
  }

  document.addEventListener("keydown", (e) => {
    // Escape closes the sheets you can back out of. It must NOT close first-run
    // setup: there is no table behind it until four players exist. The notice shares
    // that exclusion and for the same reason — there is nothing behind it either,
    // and an unacknowledged notice is not a state the app offers a way out of.
    if (e.key !== "Escape") return;
    if (!$("#disclaimer").hidden) return;
    if (hu) return closeHu();
    if (penalti) return closePenalti();
    if (koin) return closeKoin();
    if (!$("#sheet").hidden) closeSheets();
  });
}

function init() {
  wire();
  render();
  // The notice comes before setup and instead of it: one sheet at a time over one
  // shared scrim. A player who has not read it has not started.
  //
  // `return` rather than falling through — setup must not be opened behind the
  // notice, or `Mengerti` would be answering a question the player was never asked.
  if (!disclaimerAcked()) {
    show($("#disclaimer"), $("#scrim"));
    return;
  }
  // First run, or a table that never finished setup. The sheet sits over `meja`,
  // so the diamond is visible behind it as the thing being configured.
  if (store.state().players.length !== SEATS.length) openSetup();
}

// A module script is deferred, so DOMContentLoaded may already have fired.
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
