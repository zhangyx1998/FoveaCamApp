#!/usr/bin/env node
// Usage: node core/scripts/decode-serial-trace.cjs <stderr-or-combined-log>
//
// Parses Controller.cpp serial lifecycle trace lines (`trace ... seq=N`) and
// prints one timeline row per request plus terminal-state and latency summary.
// Enable the source trace with a DEBUG core build and `VERBOSE=Controller`.

const fs = require("node:fs");

const input = process.argv[2];
if (!input || input === "-h" || input === "--help") {
  console.error(
    "Usage: node core/scripts/decode-serial-trace.cjs <stderr-or-combined-log>",
  );
  process.exit(input ? 0 : 1);
}

const ANSI = /\x1b\[[0-9;]*m/g;
const TIME = /^(\d+):(\d+\.\d{3})\s+/;

function parseTime(line) {
  const match = TIME.exec(line);
  if (!match) return null;
  return Number(match[1]) * 60_000 + Number(match[2]) * 1000;
}

function fmtMs(value) {
  if (value == null || !Number.isFinite(value)) return "-";
  return value.toFixed(3);
}

function firstTime(events, predicate) {
  const event = events.find(predicate);
  return event ? event.t : null;
}

function push(map, seq, event) {
  if (!map.has(seq)) {
    map.set(seq, { seq, events: [], property: null, twoPhase: null });
  }
  const row = map.get(seq);
  row.events.push(event);
  if (event.property && !row.property) row.property = event.property;
  if (event.twoPhase != null) row.twoPhase = event.twoPhase;
  return row;
}

function parseEvent(line) {
  const t = parseTime(line);
  const trace = line.match(/\btrace\s+(.+)$/);
  if (!trace) return null;
  const text = trace[1];
  const seqMatch = text.match(/\bseq=(\d+)\b/);
  if (!seqMatch) return null;
  const seq = Number(seqMatch[1]);

  let match = text.match(
    /^tx seq=\d+ ([A-Z]+):([A-Z0-9_]+) two_phase=([01]) v2_capable=([01]) bytes=(\d+)/,
  );
  if (match) {
    return {
      seq,
      t,
      kind: "tx",
      method: match[1],
      property: match[2],
      twoPhase: match[3] === "1",
      detail: `bytes=${match[5]}`,
    };
  }

  match = text.match(
    /^rx seq=\d+ ([A-Z]+):([A-Z0-9_]+) matched=([01]) retire=([01]) pending=(.+)$/,
  );
  if (match) {
    return {
      seq,
      t,
      kind: "rx",
      method: match[1],
      property: match[2],
      matched: match[3] === "1",
      retire: match[4] === "1",
      detail: `matched=${match[3]} retire=${match[4]}`,
    };
  }

  match = text.match(
    /^task seq=\d+ branch=([a-z]+) two_phase=([01]) payload=(\d+) first8=(.*)$/,
  );
  if (match) {
    return {
      seq,
      t,
      kind: "task",
      branch: match[1],
      twoPhase: match[2] === "1",
      detail: `payload=${match[3]}`,
    };
  }

  match = text.match(/^resolve seq=\d+ phase=([a-z]+) (ok|FAILED(?:: .*)?)$/);
  if (match) {
    return {
      seq,
      t,
      kind: "resolve",
      phase: match[1],
      ok: match[2] === "ok",
      detail: match[2],
    };
  }

  match = text.match(/^drop seq=\d+ unsettled=([a-z|]+)$/);
  if (match) {
    return { seq, t, kind: "drop", detail: match[1] };
  }

  return { seq, t, kind: "unknown", detail: text };
}

function phaseMarks(row) {
  const has = (kind, pred = () => true) =>
    row.events.some((event) => event.kind === kind && pred(event));
  return [
    has("tx") ? "tx" : "no-tx",
    has("rx", (e) => e.method === "ACK" && e.matched) ? "rx-ack" : "no-rx-ack",
    has("task", (e) => e.branch === "ack") ? "task-ack" : "no-task-ack",
    has("resolve", (e) => e.phase === "accepted" && e.ok)
      ? "accepted"
      : "no-accepted",
    has("rx", (e) => e.method === "FIN" && e.matched) ? "rx-fin" : "no-rx-fin",
    has("task", (e) => e.branch === "fin") ? "task-fin" : "no-task-fin",
    has("resolve", (e) => e.phase === "completed" && e.ok)
      ? "completed"
      : "no-completed",
  ];
}

function terminal(row) {
  const failedResolve = row.events.find(
    (event) => event.kind === "resolve" && event.ok === false,
  );
  if (failedResolve) return `FAILED_${failedResolve.phase.toUpperCase()}`;
  const drop = row.events.find((event) => event.kind === "drop");
  if (drop) return `TIMEOUT_${drop.detail.toUpperCase()}`;
  const rej = row.events.find((event) => event.kind === "rx" && event.method === "REJ");
  if (rej) return "REJ";
  const completed = row.events.find(
    (event) => event.kind === "resolve" && event.phase === "completed" && event.ok,
  );
  if (completed) return row.twoPhase ? "FIN_OK" : "ACK_OK";
  const accepted = row.events.find(
    (event) => event.kind === "resolve" && event.phase === "accepted" && event.ok,
  );
  if (accepted) return "ACCEPTED_ONLY";
  return "INCOMPLETE";
}

function missing(row) {
  const marks = new Set(phaseMarks(row));
  const expected = row.twoPhase
    ? ["tx", "rx-ack", "task-ack", "accepted", "rx-fin", "task-fin", "completed"]
    : ["tx", "rx-ack", "task-ack", "completed"];
  const absent = expected.filter((mark) => !marks.has(mark));
  return absent.length ? absent.join(",") : "-";
}

function summarize(row) {
  const tx = firstTime(row.events, (event) => event.kind === "tx");
  const rxAck = firstTime(
    row.events,
    (event) => event.kind === "rx" && event.method === "ACK" && event.matched,
  );
  const rxFin = firstTime(
    row.events,
    (event) => event.kind === "rx" && event.method === "FIN" && event.matched,
  );
  const accepted = firstTime(
    row.events,
    (event) => event.kind === "resolve" && event.phase === "accepted" && event.ok,
  );
  const completed = firstTime(
    row.events,
    (event) => event.kind === "resolve" && event.phase === "completed" && event.ok,
  );
  return {
    seq: row.seq,
    property: row.property || "-",
    twoPhase: row.twoPhase == null ? "?" : row.twoPhase ? "Y" : "N",
    phases: phaseMarks(row).filter((mark) => !mark.startsWith("no-")).join(">") || "-",
    terminal: terminal(row),
    ackMs: tx != null && rxAck != null ? rxAck - tx : null,
    finMs: tx != null && rxFin != null ? rxFin - tx : null,
    acceptedMs: tx != null && accepted != null ? accepted - tx : null,
    completedMs: tx != null && completed != null ? completed - tx : null,
    missing: missing(row),
  };
}

function pad(value, width) {
  const text = String(value);
  return text.length >= width ? text : `${text}${" ".repeat(width - text.length)}`;
}

const rows = new Map();
const raw = fs.readFileSync(input, "utf8");
for (const line of raw.split(/\r?\n/)) {
  const clean = line.replace(ANSI, "");
  const event = parseEvent(clean);
  if (event) push(rows, event.seq, event);
}

const summaries = [...rows.values()]
  .map(summarize)
  .sort((a, b) => a.seq - b.seq);

const columns = [
  ["seq", 5],
  ["property", 13],
  ["2p", 3],
  ["terminal", 22],
  ["ack_ms", 9],
  ["fin_ms", 9],
  ["accepted_ms", 12],
  ["completed_ms", 13],
  ["missing", 40],
  ["phases", 0],
];

console.log(columns.map(([name, width]) => pad(name, width)).join("  "));
for (const row of summaries) {
  console.log(
    [
      pad(row.seq, 5),
      pad(row.property, 13),
      pad(row.twoPhase, 3),
      pad(row.terminal, 22),
      pad(fmtMs(row.ackMs), 9),
      pad(fmtMs(row.finMs), 9),
      pad(fmtMs(row.acceptedMs), 12),
      pad(fmtMs(row.completedMs), 13),
      pad(row.missing, 40),
      row.phases,
    ].join("  "),
  );
}

const counts = new Map();
for (const row of summaries) {
  counts.set(row.terminal, (counts.get(row.terminal) || 0) + 1);
}

const worst = (field) =>
  summaries
    .filter((row) => row[field] != null)
    .reduce((max, row) => (max == null || row[field] > max[field] ? row : max), null);

console.log("");
console.log("Summary");
console.log(`requests: ${summaries.length}`);
console.log(
  `terminal: ${[...counts.entries()].map(([state, count]) => `${state}=${count}`).join(" ") || "-"}`,
);
for (const [label, field] of [
  ["worst ack", "ackMs"],
  ["worst fin", "finMs"],
  ["worst accepted", "acceptedMs"],
  ["worst completed", "completedMs"],
]) {
  const row = worst(field);
  console.log(`${label}: ${row ? `seq=${row.seq} ${fmtMs(row[field])} ms` : "-"}`);
}
