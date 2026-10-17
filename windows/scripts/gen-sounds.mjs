// Makes the buddy's 29 sounds: soft kalimba plucks, little pops and airy
// swishes, synthesised here so they are this app's own (no samples to licence).
// Same names as before, so nothing else changes; a file of the user's own in
// the sounds folder still replaces one (src-tauri/src/sounds.rs).
//
//   node scripts/gen-sounds.mjs

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "sounds");
const RATE = 48000;
const TAU = Math.PI * 2;

/** "A4" → 440 Hz. */
function hz(note) {
  const m = /^([A-G])(#?)(\d)$/.exec(note);
  const semis = { C: -9, D: -7, E: -5, F: -4, G: -2, A: 0, B: 2 }[m[1]] + (m[2] ? 1 : 0) + (Number(m[3]) - 4) * 12;
  return 440 * 2 ** (semis / 12);
}

// Fixed seed: the same sounds every time the script runs.
let seed = 7;
const noise = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;

// ── Instruments: each returns a function of the time t (s) since it started ──

/** A kalimba tine: a sine with a quick second and third harmonic. */
const pluck = (f, { decay = 6, bright = 0.25 } = {}) => (t) => {
  const attack = Math.min(1, t / 0.004);
  const e = Math.exp(-decay * t);
  return attack * e * (Math.sin(TAU * f * t) + bright * Math.exp(-decay * t) * Math.sin(TAU * 2 * f * t)
    + 0.08 * Math.exp(-2 * decay * t) * Math.sin(TAU * 3 * f * t));
};

/** A soft bell: a tine with a faint inharmonic partial. */
const bell = (f, decay = 3.5) => {
  const tine = pluck(f, { decay, bright: 0.15 });
  return (t) => tine(t) + 0.12 * Math.exp(-decay * 1.6 * t) * Math.sin(TAU * 2.76 * f * t);
};

/** A sine whose pitch follows `pitch(t)`, under `env(t)`. */
const voice = (pitch, env) => {
  let phase = 0;
  return (t) => {
    phase += (TAU * pitch(t)) / RATE;
    return env(t) * Math.sin(phase);
  };
};

/** A bubble: a quick fall in pitch that dies away fast. */
const bubble = (from, to, dur, decay = 30) =>
  voice((t) => to + (from - to) * Math.exp(-t / (dur / 3)), (t) => Math.min(1, t / 0.002) * Math.exp(-decay * t));

/** Air: noise through a low-pass whose cutoff sweeps from `from` to `to` Hz. */
const swish = (from, to, dur) => {
  let low = 0;
  return (t) => {
    const cutoff = from * (to / from) ** Math.min(1, t / dur);
    low += (1 - Math.exp((-TAU * cutoff) / RATE)) * (noise() - low);
    return low * Math.sin(Math.PI * Math.min(1, t / dur));
  };
};

// ── Mixing ────────────────────────────────────────────────────────────────────

/** `parts`: [start (s), instrument, gain]. Normalised to `level`, faded out at the end. */
function mix(seconds, parts, level = 0.85) {
  const out = new Float32Array(Math.round(seconds * RATE));
  for (const [at, play, gain = 1] of parts) {
    const start = Math.round(at * RATE);
    for (let i = 0; start + i < out.length; i++) out[start + i] += gain * play(i / RATE);
  }
  let peak = 0;
  for (const v of out) peak = Math.max(peak, Math.abs(v));
  const fade = Math.round(0.02 * RATE);
  for (let i = 0; i < out.length; i++) {
    const tail = Math.min(1, (out.length - i) / fade);
    out[i] = (out[i] / (peak || 1)) * level * tail;
  }
  return out;
}

const notes = (list, gap, opts) => list.map((n, i) => [i * gap, pluck(hz(n), opts)]);

const SOUNDS = {
  // The panel and the island
  peek: mix(0.45, notes(["E5", "A5"], 0.09, { decay: 9 })),
  open: mix(0.5, [[0, swish(300, 2400, 0.35), 1.6], [0.12, pluck(hz("A5"), { decay: 8 }), 0.5]], 0.7),
  close: mix(0.43, [[0, swish(2400, 300, 0.3), 1.6], [0.1, pluck(hz("E5"), { decay: 9 }), 0.4]], 0.6),
  hover: mix(0.08, [[0, voice(() => 1800, (t) => Math.exp(-60 * t))]], 0.35),
  blip: mix(0.1, [[0, pluck(hz("C6"), { decay: 30 })]], 0.6),
  tick: mix(0.07, [[0, voice(() => 2600, (t) => Math.exp(-90 * t))]], 0.4),

  // Claude at work
  work: mix(0.38, notes(["G5", "C6"], 0.08, { decay: 12 }), 0.7),
  think: mix(0.44, notes(["A5", "C6", "A5"], 0.12, { decay: 14 }), 0.55),
  search: mix(0.46, notes(["C6", "E6", "G6", "E6"], 0.06, { decay: 16 }), 0.5),
  finish: mix(1.16, [...notes(["C5", "E5", "G5", "C6"], 0.1, { decay: 4 }), [0.42, pluck(hz("E6"), { decay: 6 }), 0.3]]),
  error: mix(0.84, [...notes(["E4", "C4"], 0.22, { decay: 5 }), [0, voice(() => hz("C3"), (t) => Math.exp(-4 * t)), 0.3]]),
  rate: mix(0.67, notes(["A4", "E4"], 0.25, { decay: 4 }), 0.75),
  approval: mix(0.88, [[0, bell(hz("G5"))], [0.28, bell(hz("D5"))]]),
  question: mix(0.7, notes(["A4", "E5"], 0.16, { decay: 6 })),
  approve: mix(0.6, notes(["E5", "B5"], 0.09, { decay: 7 })),
  send: mix(0.48, [[0, swish(500, 3500, 0.3), 1.5], [0.2, pluck(hz("B5"), { decay: 10 }), 0.5]], 0.7),
  attach: mix(0.9, [
    ...notes(["D5", "A5"], 0.08, { decay: 7 }),
    [0.18, voice(() => 120, (t) => Math.exp(-20 * t)), 0.8],
  ]),

  // The buddy's moods
  greet: mix(0.75, [...notes(["C5", "E5", "G5"], 0.1, { decay: 6 }), [0.32, pluck(hz("C6"), { decay: 7 }), 0.6]]),
  slap: mix(0.6, [[0, voice((t) => 380 + 140 * Math.cos(TAU * 9 * t) * Math.exp(-5 * t), (t) => Math.min(1, t / 0.003) * Math.exp(-5 * t))]]),
  annoyed: mix(0.59, [
    [0, pluck(hz("D4"), { decay: 7 })], [0.004, pluck(hz("D4") * 1.012, { decay: 7 }), 0.6],
    [0.2, pluck(hz("C#4"), { decay: 7 })], [0.204, pluck(hz("C#4") * 1.012, { decay: 7 }), 0.6],
  ]),
  dizzy: mix(0.98, [[0, voice((t) => 660 + 120 * Math.sin(TAU * 7 * t), (t) => Math.sin(Math.PI * t / 0.98) * (0.7 + 0.3 * Math.sin(TAU * 5 * t)))]], 0.6),
  love: mix(0.79, [
    [0, pluck(hz("E5"), { decay: 4 })], [0.03, pluck(hz("G#5"), { decay: 4 })], [0.06, pluck(hz("B5"), { decay: 4 })],
    [0.25, pluck(hz("E6"), { decay: 6 }), 0.4],
  ]),
  pop: mix(0.38, [[0, bubble(900, 280, 0.06)]], 0.7),
  gulp: mix(0.75, [[0, bubble(420, 140, 0.18, 9)], [0.25, bubble(700, 300, 0.08, 25), 0.5]]),
  proud: mix(0.86, [...notes(["G4", "C5", "E5", "G5"], 0.07, { decay: 6 }), [0.34, pluck(hz("C6"), { decay: 5 }), 0.8]]),
  wink: mix(0.21, notes(["E6", "B6"], 0.06, { decay: 18 }), 0.55),
  yawn: mix(0.73, [
    [0, voice((t) => 300 + 220 * Math.sin(Math.PI * Math.min(1, t / 0.5)) - 60 * Math.max(0, t - 0.4), (t) => Math.sin(Math.PI * t / 0.73) ** 2)],
    [0, swish(800, 600, 0.6), 0.25],
  ], 0.5),
  sleep: mix(0.45, notes(["G5", "E5", "C5"], 0.1, { decay: 8 }), 0.5),

  // The launch greeting: a little tune, a bass under it, an open chord to end.
  greeting: mix(4.17, [
    ...["C5", "E5", "G5", "A5", "G5", "E5", "D5", "E5", "C5"].map((n, i) => [i * 0.3, pluck(hz(n), { decay: 3.5 })]),
    [0, pluck(hz("C3"), { decay: 1.2, bright: 0.1 }), 0.5],
    [1.2, pluck(hz("A2"), { decay: 1.2, bright: 0.1 }), 0.5],
    [2.4, pluck(hz("C3"), { decay: 1.2, bright: 0.1 }), 0.5],
    [2.85, pluck(hz("G5"), { decay: 2 }), 0.6],
    [2.88, pluck(hz("C6"), { decay: 2 }), 0.5],
  ]),
};

// ── WAV (48 kHz, 16-bit mono) ─────────────────────────────────────────────────

function wav(samples) {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((v, i) => data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v)) * 32767), i * 2));
  const head = Buffer.alloc(44);
  head.write("RIFF", 0);
  head.writeUInt32LE(36 + data.length, 4);
  head.write("WAVEfmt ", 8);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20); // PCM
  head.writeUInt16LE(1, 22); // mono
  head.writeUInt32LE(RATE, 24);
  head.writeUInt32LE(RATE * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write("data", 36);
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

mkdirSync(OUT, { recursive: true });
for (const [name, samples] of Object.entries(SOUNDS)) {
  writeFileSync(join(OUT, `${name}.wav`), wav(samples));
}
console.log(`${Object.keys(SOUNDS).length} sounds → ${OUT}`);
