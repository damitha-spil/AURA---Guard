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

export type ColorTheme = (typeof COLOR_THEMES)[number]["id"];

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
