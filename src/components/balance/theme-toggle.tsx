import { useEffect } from "react";
import { Moon, Sun } from "lucide-react";
import { useTheme } from "@/lib/theme";

export function ThemeSync() {
  useEffect(() => {
    useTheme.getState().hydrate();
  }, []);
  return null;
}

export function ThemeToggle() {
  const theme = useTheme((s) => s.theme);
  const toggle = useTheme((s) => s.toggle);
  const dark = theme === "dark";

  return (
    <button
      type="button"
      onClick={toggle}
      className="grid size-11 place-items-center rounded-md text-mute hover:bg-raised hover:text-ink"
      aria-label={dark ? "切换亮色" : "切换暗色"}
      title={dark ? "亮色" : "暗色"}
    >
      {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </button>
  );
}
