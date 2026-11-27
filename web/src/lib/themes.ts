export const COLOR_THEMES = [
  { id: "green", label: "Green" },
  { id: "neutral", label: "Neutral" },
  { id: "blue", label: "Blue" },
  { id: "violet", label: "Violet" },
  { id: "orange", label: "Orange" },
  { id: "rose", label: "Rose" },
  { id: "red", label: "Red" },
  { id: "yellow", label: "Yellow" },
  { id: "amber", label: "Amber" },
] as const;

export type ColorTheme = (typeof COLOR_THEMES)[number]["id"] | "custom";

export interface Accent {
  light: string;
  dark: string;
}

/** Primary colour of each theme (lightness, chroma, hue), copied from index.css for the drawn previews. */
const PRIMARIES: Record<string, { light: [number, number, number]; dark: [number, number, number] }> = {
  green: { light: [0.527, 0.154, 150], dark: [0.448, 0.119, 151] },
  neutral: { light: [0.205, 0, 0], dark: [0.922, 0, 0] },
  blue: { light: [0.546, 0.245, 262], dark: [0.623, 0.245, 262] },
  violet: { light: [0.541, 0.28, 293], dark: [0.606, 0.28, 293] },
  orange: { light: [0.646, 0.22, 45], dark: [0.705, 0.22, 45] },
  rose: { light: [0.586, 0.25, 17], dark: [0.645, 0.25, 17] },
  red: { light: [0.577, 0.245, 27], dark: [0.637, 0.245, 27] },
  yellow: { light: [0.795, 0.18, 88], dark: [0.852, 0.18, 88] },
  amber: { light: [0.666, 0.18, 62], dark: [0.769, 0.18, 62] },
};

type Seed = { hue: number; chroma: number };
const oklch = ([l, c, h]: [number, number, number]) => `oklch(${l} ${c} ${h})`;

export function themeAccent(theme: ColorTheme, custom: Seed | null): Accent {
  if (theme === "custom") {
    const { hue, chroma } = custom ?? themeSeed("green", null);
    // Same lightness as [data-theme="custom"] in index.css.
    return { light: oklch([0.53, chroma, hue]), dark: oklch([0.55, chroma, hue]) };
  }
  return { light: oklch(PRIMARIES[theme].light), dark: oklch(PRIMARIES[theme].dark) };
}

/** Where a new custom theme starts when it is copied from another theme. */
export function themeSeed(theme: ColorTheme, custom: Seed | null): Seed {
  if (theme === "custom" && custom) return { hue: custom.hue, chroma: custom.chroma };
  const [, chroma, hue] = (PRIMARIES[theme] ?? PRIMARIES.green).light;
  return { hue, chroma: Math.min(chroma, 0.25) };
}

export const RADII = [
  { id: "none", label: "None" },
  { id: "small", label: "Small" },
  { id: "default", label: "Default" },
  { id: "large", label: "Large" },
] as const;

export type Radius = (typeof RADII)[number]["id"];

export function readTheme(): ColorTheme {
  try {
    const v = localStorage.getItem("color-theme");
    if (v === "custom") return v;
    if (COLOR_THEMES.some((t) => t.id === v)) return v as ColorTheme;
  } catch {
    // storage unavailable
  }
  return "green";
}

export function readRadius(): Radius {
  try {
    const v = localStorage.getItem("radius");
    if (RADII.some((r) => r.id === v)) return v as Radius;
  } catch {
    // storage unavailable
  }
  return "default";
}

export function writeTheme(theme: ColorTheme) {
  const el = document.documentElement;
  if (theme === "green") el.removeAttribute("data-theme");
  else el.setAttribute("data-theme", theme);
  try {
    if (theme === "green") localStorage.removeItem("color-theme");
    else localStorage.setItem("color-theme", theme);
  } catch {
    // storage unavailable
  }
}

export function writeRadius(radius: Radius) {
  const el = document.documentElement;
  if (radius === "default") el.removeAttribute("data-radius");
  else el.setAttribute("data-radius", radius);
  try {
    if (radius === "default") localStorage.removeItem("radius");
    else localStorage.setItem("radius", radius);
  } catch {
    // storage unavailable
  }
}
