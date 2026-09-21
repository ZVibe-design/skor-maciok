// P3 scoring app — the rule table, and the only place any rule number lives.
// Task 14 verifies that no literal 300 escapes this file.
//
// Source: YDSP Revisi 3 (DECISIONS.md — "Rule Base: YDSP Revisi 3"), except where
// a row cites Chandra 2026-09-17: the base win settlement has no documentary
// source at all (see DECISIONS.md — "P3 Settlement Rule: Chandra-sourced,
// Isolated Module"). Row numbers below are YDSP citations.

/** Default starting stack. Default only — never hard-coded downstream. */
export const DEFAULT_START = 300;

/** YDSP G1 — a winning hand is worth at least 5 tay. */
export const MIN_FU_TAY = 5;

/** YDSP P7 — a win under 5 Fu is recorded as 10 tay, not as its raw value. */
export const FU_FLOOR_TAY = 10;

/** The citation shown beside the floor warning. Kept here with the numbers it cites. */
export const FU_FLOOR_CITE = "YDSP P7";

/**
 * YDSP P8 and P9 — both end in the same consequence: `Ping Fu tidak dihitung`.
 *
 * These are the two rows the app cannot apply for itself. Whether the pair that
 * would have been the pair of a Ping Fu hand is the round wind or a dragon is a
 * fact about the tiles, and the app never sees the tiles — tay entry is manual by
 * design. So the rule is stated where the number is typed and the player types the
 * corrected tay (Task 6 scope note: "the dialog shows the reminder and Chandra
 * types the corrected tay").
 *
 * Shown on every tay entry rather than only on a Ping Fu hand, because Ping Fu is a
 * *hand composition* (YDSP G4), not one of the six settlement methods in
 * `HU_METHODS` — a Ping Fu hand can be won by Ce Mo or by Ta Cung, so there is no
 * method to gate the reminder on. Showing it always is the honest option; hiding it
 * would need the app to know something it structurally cannot.
 */
export const PING_FU_CITE = "YDSP P8, P9";
export const PING_FU_REMINDER =
  "Ping Fu tidak dihitung kalau angin putaran atau Cung/Fat/Pai dipakai jadi kaki (ciok)";

/**
 * YDSP P1, G2, G3, P10, S37, S38.
 * `selfDraw` decides the settlement shape: the discarder pays a double share
 * on a taCung win, and there are only two non-winner payers; on a self-draw
 * every opponent pays double and there are three.
 *
 * `cite` is the row reference the Hu sheet prints under each label. It is data,
 * not a comment, because the sheet renders it — and it is here rather than in
 * `ui.js` because this file is the only place a rule number may live. Three of
 * the six carry a ref their `scoring-table.mjs` row does not (Ce Mo is G2 *and*
 * P10), which is why these are written out rather than matched by hand name.
 */
export const HU_METHODS = {
  taCung:       { label: "Ta Cung (dari buangan)", selfDraw: false, cite: "YDSP P1" },      // YDSP P1
  ceMo:         { label: "Ce Mo",                  selfDraw: true,  cite: "YDSP G2 + P10" }, // YDSP G2 + P10
  ceMoPuCiuJen: { label: "Ce Mo Pu Ciu Jen",       selfDraw: true,  cite: "YDSP G3 + P10" }, // YDSP G3 + P10
  pyongPi:      { label: "Pyong Pi",               selfDraw: true,  cite: "YDSP P10" },      // YDSP P10
  thiFu:        { label: "Thi Fu",                 selfDraw: true,  cite: "YDSP S37" },      // YDSP S37 — Chandra 2026-09-17
  thienFu:      { label: "Thien Fu",               selfDraw: true,  cite: "YDSP S38" },      // YDSP S38 — Chandra 2026-09-17
};

/** Paid in coins at the table, never part of tay. Each opponent pays the collector. */
export const KOIN = {
  kong:        { label: "Kong",          amount: 1 },
  kongCung:    { label: "Kong Cung",     amount: 2 },
  amKong:      { label: "Am Kong",       amount: 2 },
  amKongCung:  { label: "Am Kong Cung",  amount: 4 },
  bungaHitam4: { label: "4 Bunga Hitam", amount: 4 },
  bungaMerah4: { label: "4 Bunga Merah", amount: 8 },
};

/**
 * `pays: false` means the penalty is a restriction, not a point transfer —
 * YDSP P2–P4. It is recorded so the night is traceable, and it moves nothing.
 *
 * `point` has **no v1 row**: every YDSP penalty row that moves points is either
 * already priced by the Hu flow (rows 1 and 10), is the tay floor (row 7), or is
 * excluded pending a settlement shape `settle.js` does not have (rows 5 and 6 —
 * see `PENALTY_EXCLUDED`). The branch is kept because it is correct and priced,
 * not because the UI reaches it today; Task 7 must not build a number pad for it.
 */
export const PENALTY_KINDS = {
  point:  { label: "Denda poin", pays: true  },
  lewFit: { label: "Lew Fit",    pays: false },
};

/**
 * YDSP P2–P4 — the penalty rows v1 actually offers. All three are Lew Fit: the
 * same consequence from three different causes, which is why `row` travels on the
 * event and `kind` alone is not enough. A log reading "Budi — Lew Fit" does not
 * answer the question the log exists to answer, and LAW 4 asks for the *why*.
 *
 * Copied from `PENALTIES` in `src/data/scoring-table.mjs` rather than imported.
 * That file is `.mjs` and lives outside `src/app/`, and the build is an asset copy
 * of `src/app/**` + `src/tiles/**` — so the app cannot reach it at runtime, and
 * Task 7 step 1's "sourced from `PENALTIES` … do not re-type them" is impossible
 * as written. A test asserts these rows still match the source, so the copy cannot
 * drift, and it fails in both directions: an edited row, or a source row that no
 * longer appears here or in `PENALTY_EXCLUDED`.
 */
export const PENALTY_ROWS = [
  { no: 2, name: "Kelebihan atau kekurangan kartu", kind: "lewFit",
    desc: "Kurang kartu atau lebih kartu on hand dalam permainan setelah ketauan langsung penalti" },
  { no: 3, name: "Salah cia atau pung", kind: "lewFit",
    desc: "Cia atau pung yang tidak sesuai, setelah ketauan langsung penalti" },
  { no: 4, name: "Cia / Pung menggunakan kim", kind: "lewFit",
    desc: "Cia atau pung menggunakan kim di dalam cia atau pung nya, setelah ketauan lgs penalti" },
];

/**
 * The YDSP penalty rows v1 deliberately does **not** offer, and why. Every row in
 * `PENALTIES` is either in `PENALTY_ROWS` or here — a test asserts the union is
 * exactly rows 1–10, so a re-extraction that adds or renumbers a row fails the
 * suite instead of the row quietly vanishing from the app.
 *
 * Rows 1 and 10 are not penalties the app forgot; they are prices the Hu flow
 * already charges. Offering them under Penalti would charge them twice — the same
 * reasoning that already excluded row 7.
 */
export const PENALTY_EXCLUDED = {
  1:  "sudah dibayar alur Hu — taCung membuat pembuang bayar 2×",
  5:  "butuh bentuk penyelesaian ketiga yang settle.js belum punya (Chandra 2026-09-17: keluar dari v1)",
  6:  "butuh bentuk penyelesaian ketiga yang settle.js belum punya (Chandra 2026-09-17: keluar dari v1)",
  7:  "lantai tay di alur Hu (Task 6 step 4) — bukan penalti terpisah",
  8:  "pengingat di alur Hu (Task 6 step 4b) — Ping Fu tidak dihitung",
  9:  "pengingat di alur Hu (Task 6 step 4b) — Ping Fu tidak dihitung",
  10: "sudah dibayar alur Hu — Ce Mo / Cemo / Pyong Pi membuat semua bayar 2×",
};
