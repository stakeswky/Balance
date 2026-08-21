import { create } from "zustand";

export type Theme = "light" | "dark";

const KEY = "remain-theme";

function readTheme(): Theme {
  if (typeof document === "undefined") return "light";
  const fromDom = document.documentElement.dataset.theme;
  if (fromDom === "dark" || fromDom === "light") return fromDom;
  try {
    const stored = localStorage.getItem(KEY);
    if (stored === "dark" || stored === "light") return stored;
  } catch {
    /* ignore */
  }
  return "light";
}

function applyTheme(theme: Theme) {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  meta?.setAttribute("content", theme === "dark" ? "#09090b" : "#f2efe8");
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    /* ignore */
  }
}

export const useTheme = create<{
  theme: Theme;
  setTheme: (theme: Theme) => void;
  toggle: () => void;
  hydrate: () => void;
}>((set, get) => ({
  theme: "light",
  setTheme: (theme) => {
    applyTheme(theme);
    set({ theme });
  },
  toggle: () => get().setTheme(get().theme === "light" ? "dark" : "light"),
  hydrate: () => {
    const theme = readTheme();
    applyTheme(theme);
    set({ theme });
  },
}));

export const THEME_BOOT =
  "(function(){try{var t=localStorage.getItem('remain-theme');if(t!=='dark'&&t!=='light')t='light';document.documentElement.dataset.theme=t;document.documentElement.style.colorScheme=t;}catch(e){document.documentElement.dataset.theme='light'}})();";
