import { SidebarTrigger, useSidebar } from "@vibest/ui/components/sidebar";
import { cn } from "@vibest/ui/lib/utils";

/**
 * Still one fixed toggle for every state rather than a copy inside the sidebar
 * and a copy outside it: the offcanvas sidebar carries an inside toggle
 * off-screen on collapse, and swapping two copies flickers. Only its x moves,
 * animated in step with the sidebar slide.
 *
 * On mobile it is centered in the header's reserved leading slot. On desktop,
 * expanded sits at the sidebar's inner right edge — `--sidebar-width` less the
 * sidebar's own p-1.5, the group's p-2, and the size-7 button. Collapsed takes
 * the corner over, unless macOS's traffic lights already own it.
 */
export function ShellToggle({ hasTrafficLights }: { hasTrafficLights: boolean }) {
  const { state, isMobile } = useSidebar();
  const expanded = state === "expanded";

  return (
    <SidebarTrigger
      className={cn(
        "fixed z-30 transition-[left] duration-200 ease-linear [-webkit-app-region:no-drag]",
        isMobile
          ? "top-5 left-7 -translate-x-1/2 -translate-y-1/2"
          : cn(
              "top-[11px]",
              expanded
                ? "left-[calc(var(--sidebar-width)-3.375rem)]"
                : hasTrafficLights
                  ? "left-22"
                  : "left-2",
            ),
      )}
    />
  );
}
