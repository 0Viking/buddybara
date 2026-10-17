// Shared names and sizes: Buddybara's states and emotes, the alerts that bring
// the panel up, and the panel's size (island.rs uses the same numbers).

/** What brings the panel up by itself (island/hooks.ts → src/buddy). */
export type AlertView = "approval" | "question" | "finished" | "error";

export type BotStateName =
  | "idle"
  | "working"
  | "thinking"
  | "searching"
  | "approval"
  | "question"
  | "error"
  | "finished"
  | "ratelimit"
  | "sleeping"
  | "dizzy";

export type BotEmoteName = "love" | "surprised" | "proud" | "wink" | "yawn" | "happy" | "annoyed";

export const BUDDY_W = 600;
export const BUDDY_H = 660;
/** Transparent room each side of the panel in its window, for the genie's funnel (island.rs BUDDY_NECK). */
export const BUDDY_NECK = 40;
