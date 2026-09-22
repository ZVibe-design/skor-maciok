// P3 settlement core — pure arithmetic. No DOM, no storage, no imports from
// ui.js or store.js. This boundary is load-bearing: the settlement rule has no
// source document (DECISIONS.md — "P3 Settlement Rule"), so a correction from
// the table must cost this one file plus a `npm test` re-run. If settlement
// arithmetic leaks out of here, that mitigation is void (Task 14 greps for it).
//
// Every event in this game is zero-sum by construction: each transfer moves
// points from one player to another and creates none. That is what makes
// Σ balances === 0 an assertion rather than a hope.

import { FU_FLOOR_TAY, HU_METHODS, KOIN, MIN_FU_TAY, PENALTY_KINDS, PENALTY_ROWS } from "./rules.js";

/** Player ids, accepting either `["a","b"]` or `[{id:"a"},…]` (the store's shape). */
function playerIds(players) {
  if (!Array.isArray(players)) throw new TypeError("players harus array");
  const ids = players.map((p) => (typeof p === "string" ? p : p?.id));
  for (const id of ids) {
    if (typeof id !== "string" || id === "") throw new TypeError("setiap pemain butuh id berupa string");
  }
  if (new Set(ids).size !== ids.length) throw new TypeError("id pemain duplikat");
  return ids;
}

function requirePlayer(id, ids, field) {
  if (typeof id !== "string" || !ids.includes(id)) {
    throw new TypeError(`${field} tidak ada di daftar pemain: ${JSON.stringify(id)}`);
  }
  return id;
}

function requirePositiveInt(value, field) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${field} harus bilangan bulat positif, dapat: ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * A table lookup that cannot be answered by `Object.prototype`.
 *
 * `KOIN["toString"]` is a function and therefore truthy, so a plain
 * `if (!KOIN[kind]) throw` waves it through and prices the transfer with
 * `amount: undefined` — every score becomes `NaN` and Σ stops meaning anything.
 * Measured before Task 8 was built, not reasoned about. `Object.hasOwn` makes the
 * lookup answer only for keys the table actually declares, which is what every
 * closed-set lookup in this file means by "known".
 */
function own(table, key) {
  return typeof key === "string" && Object.hasOwn(table, key) ? table[key] : undefined;
}

/**
 * Which koreksi is holding which event down, as `Map<correctedId, koreksiId>`.
 *
 * The one walk, shared with `resolveEvents` so the two can never disagree about
 * what stands. Both roles matter and they are not the same question: `resolveEvents`
 * asks *whether* an event counts, and the scoreboard's Undo button has to ask
 * *which* koreksi to cancel, because on an already-cancelled row the button's target
 * is the koreksi rather than the row.
 *
 * Measured, not reasoned: given `X, K1→X, K2→X, K3→K2` the newest koreksi pointing at
 * X is K2, but K2 has itself been undone, so K1 is the one that counts. A button that
 * targets the newest appends a koreksi pointing at K2 and **X stays cancelled** — the
 * row appears and nothing moves. That is the tap `resolveEvents` exists to prevent,
 * which is why the id has to come from here and not from a fresh scan of `corrects`.
 */
export function cancellations(events) {
  if (!Array.isArray(events)) throw new TypeError("events harus array");
  // Walk newest-first: a koreksi counts only while it has not itself been
  // cancelled by a later one. A koreksi always targets an earlier event, so by
  // the time the loop reaches one, every koreksi pointing at it has been seen.
  const by = new Map();
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i];
    if (e?.type !== "koreksi" || typeof e.corrects !== "string") continue;
    if (by.has(e.id)) continue; // this undo was itself undone
    // Newest wins: the walk reaches the later koreksi first, and the first
    // answer is the live one.
    if (!by.has(e.corrects)) by.set(e.corrects, e.id);
  }
  return by;
}

/**
 * LAW 5 — corrections are additive, never destructive.
 *
 * The log keeps the original event *and* the koreksi that cancels it; both stay
 * traceable (LAW 4) and both drop out of the arithmetic. That makes an undo a
 * compensating event rather than a splice, and makes "the sum is unchanged"
 * true by construction instead of by careful bookkeeping.
 *
 * Returns a new array; the input is never mutated.
 */
export function resolveEvents(events) {
  // This makes undo a toggle rather than a one-way door: one undo cancels, two
  // restore, three cancel again. A single forward pass over every `corrects`
  // would instead read the *first* koreksi as final, so undoing an undo would
  // add a log row and move nothing — a tap that silently does nothing, which is
  // the one failure a scorekeeper cannot afford. Task 9 puts Undo on every
  // history row, so that tap is reachable.
  const cancelled = cancellations(events);
  return events.filter((e) => e.type !== "koreksi" && !cancelled.has(e.id));
}

/**
 * The transfers one event moves, as `[{ from, to, amount, reason }]`.
 *
 * Throws TypeError rather than returning a zero transfer for a malformed
 * event: an event that cannot be priced is a bug in the caller, and pricing it
 * at zero is how a settlement engine loses points silently.
 */
export function transfersFor(event, players) {
  const ids = playerIds(players);
  if (!event || typeof event !== "object") throw new TypeError("event tidak valid");

  switch (event.type) {
    case "hu": {
      const tay = requirePositiveInt(event.tay, "tay");
      // `own`, for the same reason as the penalty and koin lookups below: a plain
      // `HU_METHODS[event.method]` answers for `Object.prototype`. Measured before
      // Task 9 was built — the door let a `hu` naming a method the table does not
      // declare into the log (`problem() === null`, row present) and this line then
      // threw during render, which is the blank table with no banner that Tasks 7
      // and 8 closed for the other two tables. `HU_METHODS` is the fourth closed
      // set, and it was the only one still open.
      //
      // The error is also honest now: `method: "toString"` used to fall through to
      // the taCung branch and report a missing `discarderId`, which named the wrong
      // problem.
      const method = own(HU_METHODS, event.method);
      if (!method) throw new TypeError(`metode hu tidak dikenal: ${JSON.stringify(event.method)}`);
      const winner = requirePlayer(event.winnerId, ids, "winnerId");
      const others = ids.filter((id) => id !== winner);

      if (method.selfDraw) {
        // Self-draw: each of the three opponents pays double.
        return others.map((id) => ({ from: id, to: winner, amount: 2 * tay, reason: "hu" }));
      }

      // taCung: the discarder pays double, the other two pay single.
      const discarder = requirePlayer(event.discarderId, ids, "discarderId");
      if (discarder === winner) throw new TypeError("discarderId tidak boleh sama dengan winnerId");
      return [
        { from: discarder, to: winner, amount: 2 * tay, reason: "taCung" },
        ...others
          .filter((id) => id !== discarder)
          .map((id) => ({ from: id, to: winner, amount: tay, reason: "taCung" })),
      ];
    }

    case "penalty": {
      // `own`, not `PENALTY_KINDS[kind]`: the penalty branch happens to survive a
      // prototype key today — `PENALTY_KINDS["toString"].pays` is `undefined`, so it
      // falls through to the row lookup and throws — but that is luck, not a rule,
      // and it stops being true the moment a kind gains a defaulted field.
      const kind = own(PENALTY_KINDS, event.kind);
      if (!kind) throw new TypeError(`jenis penalti tidak dikenal: ${JSON.stringify(event.kind)}`);
      const offender = requirePlayer(event.offenderId, ids, "offenderId");

      // `row` says *why*, independently of `kind`, which says what happened to the
      // player. A row that is present must be a real one, and must agree with the
      // consequence: a row paired with the wrong kind is the one mismatch that
      // changes the arithmetic, since it would price a Lew Fit as a fine.
      const hasRow = event.row !== undefined && event.row !== null;
      const row = hasRow ? PENALTY_ROWS.find((r) => r.no === event.row) : null;
      if (hasRow && !row) throw new TypeError(`baris penalti tidak dikenal: ${JSON.stringify(event.row)}`);
      if (row && row.kind !== event.kind) {
        throw new TypeError(`baris penalti ${row.no} bukan jenis ${JSON.stringify(event.kind)}`);
      }

      if (!kind.pays) {
        // Required here and not for `point`, because this is the case where the row
        // is load-bearing: a Lew Fit moves nothing, so `row` is the *whole* of what
        // the event records. Three causes share this consequence, and without the
        // row the log says a player was penalised without saying what for — which
        // is not a record of anything. A fine carries its amount, so a `point`
        // event is not empty without provenance, and requiring a row there would
        // make the branch unpriceable: no YDSP row surviving v1's exclusions
        // (rows 1, 5, 6, 7, 10) has the `point` consequence.
        if (!row) throw new TypeError("penalti lewFit butuh row — baris YDSP-nya satu-satunya isi catatan");
        return [];
      }
      // D3 default: per-player. The offender pays the fine to each other player.
      const fine = requirePositiveInt(event.fine, "fine");
      return ids
        .filter((id) => id !== offender)
        .map((id) => ({ from: offender, to: id, amount: fine, reason: "penalti" }));
    }

    case "koin": {
      const koin = own(KOIN, event.kind);
      if (!koin) throw new TypeError(`jenis koin tidak dikenal: ${JSON.stringify(event.kind)}`);
      const collector = requirePlayer(event.collectorId, ids, "collectorId");
      return ids
        .filter((id) => id !== collector)
        .map((id) => ({ from: id, to: collector, amount: koin.amount, reason: "koin" }));
    }

    case "utang":
      // A loan moves no points. It is priced here anyway so a malformed amount
      // cannot sit in the ledger unnoticed until balancesFrom runs.
      requirePositiveInt(event.amount, "amount");
      return [];

    case "koreksi":
      throw new TypeError("koreksi tidak punya aritmetika sendiri — panggil resolveEvents() dulu");

    default:
      throw new TypeError(`tipe event tidak dikenal: ${JSON.stringify(event?.type)}`);
  }
}

/** score_i = start + Σ incoming − Σ outgoing. */
export function scoresFrom(events, players, start) {
  const ids = playerIds(players);
  if (!Number.isInteger(start) || start < 0) {
    throw new TypeError(`start harus bilangan bulat >= 0, dapat: ${JSON.stringify(start)}`);
  }
  const scores = new Map(ids.map((id) => [id, start]));
  for (const event of resolveEvents(events)) {
    for (const t of transfersFor(event, ids)) {
      scores.set(t.from, scores.get(t.from) - t.amount);
      scores.set(t.to, scores.get(t.to) + t.amount);
    }
  }
  return scores;
}

/**
 * A loan's two legs and its amount — validated once, for both aggregations below.
 *
 * `borrower !== lender` is checked here and not only at the door because this is
 * where it becomes arithmetic: a self-loan cancels itself out of `balancesFrom`
 * and would read as a loan that moves nothing, which is not a thing a table can do.
 */
function utangLegs(event, ids) {
  const amount = requirePositiveInt(event.amount, "amount");
  const borrower = requirePlayer(event.borrowerId, ids, "borrowerId");
  const lender = requirePlayer(event.lenderId, ids, "lenderId");
  if (borrower === lender) throw new TypeError("borrowerId dan lenderId tidak boleh sama");
  return { borrower, lender, amount };
}

/**
 * What each player is actually owed or owes, once loans are folded in.
 * balance_i = (score_i − start) − diambil_i + diberi_i
 *
 * A borrower's balance goes down and the lender's goes up by the same amount,
 * so Σ balances === 0 holds here too — including while a loan is outstanding.
 */
export function balancesFrom(events, players, start) {
  const ids = playerIds(players);
  const scores = scoresFrom(events, ids, start);
  const balances = new Map(ids.map((id) => [id, scores.get(id) - start]));
  for (const event of resolveEvents(events)) {
    if (event.type !== "utang") continue;
    const { borrower, lender, amount } = utangLegs(event, ids);
    balances.set(borrower, balances.get(borrower) - amount);
    balances.set(lender, balances.get(lender) + amount);
  }
  return balances;
}

/**
 * Who pays whom, to clear the table in as few transfers as possible.
 * Greedy: the largest debtor pays the largest creditor, repeatedly. Each
 * iteration zeroes at least one player, so the result is never longer than
 * n − 1 transfers. Does not mutate the input map.
 */
export function settleUp(balances) {
  const work = [...balances].map(([id, amount]) => {
    if (!Number.isInteger(amount)) {
      throw new TypeError(`saldo ${id} bukan bilangan bulat: ${JSON.stringify(amount)}`);
    }
    return { id, amount };
  });

  const pick = (pred) => {
    let best = null;
    for (const w of work) {
      if (!pred(w.amount)) continue;
      if (best === null || w.amount > best.amount || (w.amount === best.amount && w.id < best.id)) best = w;
    }
    return best;
  };

  const transfers = [];
  for (;;) {
    const debtor = pick((a) => a < 0);
    const creditor = pick((a) => a > 0);
    if (!debtor || !creditor) break;
    const amount = Math.min(-debtor.amount, creditor.amount);
    debtor.amount += amount;
    creditor.amount -= amount;
    transfers.push({ from: debtor.id, to: creditor.id, amount });
  }
  return transfers;
}

/** YDSP P7 — a win under 5 Fu settles as 10 tay. */
export function applyFuFloor(tay) {
  return tay > 0 && tay < MIN_FU_TAY ? FU_FLOOR_TAY : tay;
}
