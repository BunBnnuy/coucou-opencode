// Theme plumbing. The palette lives in CSS variables; the island copies the
// "dark" | "light" | "system" setting onto <body>, and the canvases (which
// cannot use variables) read the resolved colours from here.

export interface Palette {
  ink: string;
  ink2: string;
  dim: string;
  dim2: string;
  ink3: string;
  island: string;
  card: string;
}

export let palette: Palette = {
  ink: "#f5f6f8",
  ink2: "#f1f2f4",
  dim: "#9398a1",
  dim2: "#a9adb5",
  ink3: "#c4c5ca",
  island: "#000000",
  card: "#0d0e10",
};

export function refreshPalette() {
  const styles = getComputedStyle(document.body);
  const value = (name: string, fallback: string) => styles.getPropertyValue(name).trim() || fallback;
  palette = {
    ink: value("--ink", "#f5f6f8"),
    ink2: value("--ink-2", "#f1f2f4"),
    dim: value("--dim", "#9398a1"),
    dim2: value("--dim-2", "#a9adb5"),
    ink3: value("--ink-3", "#c4c5ca"),
    island: value("--island-bg", "#000000"),
    card: value("--card", "#0d0e10"),
  };
}

/** Applies the theme class; `systemLight` is the OS preference. */
export function applyThemeClass(mode: string, systemLight: boolean) {
  const light = mode === "light" || (mode === "system" && systemLight);
  document.body.classList.toggle("theme-light", light);
  refreshPalette();
}

/** True when the OS is currently in light mode. */
export function systemPrefersLight(): boolean {
  return window.matchMedia("(prefers-color-scheme: light)").matches;
}

/**
 * The main blob's body gradient, derived from one base colour: the bottom is
 * the base, the top is lifted toward white. Mirrors BotEngine.drawBody, which
 * takes the same base as RGB.
 */
export const DEFAULT_MOCHI = "#C4C5CA";

export let mochi = { top: "#EDEDEF", bottom: DEFAULT_MOCHI };

export function setMochiColor(hex: string | null | undefined) {
  const match = /^#?([0-9a-f]{6})$/i.exec((hex ?? "").trim());
  const base = match
    ? [parseInt(match[1].slice(0, 2), 16), parseInt(match[1].slice(2, 4), 16), parseInt(match[1].slice(4, 6), 16)]
    : [196, 197, 202];
  const top = base.map((c) => Math.round(c + (255 - c) * 0.65));
  const toHex = (rgb: number[]) => `#${rgb.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
  mochi = { top: toHex(top), bottom: toHex(base) };
}
