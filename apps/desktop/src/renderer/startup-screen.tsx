import { useAnimate } from "motion/react-mini";
import { useEffect, type ReactElement } from "react";

import vibestLogoUrl from "../../resources/v.svg?url";

import "./startup-screen.css";

const EASE = [0.22, 1, 0.36, 1] as const;

export function StartupScreen(): ReactElement {
  const [scope, animate] = useAnimate<HTMLDivElement>();
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  useEffect(() => {
    if (reducedMotion) return;

    const animation = animate(
      scope.current,
      {
        clipPath: ["inset(0 100% 0 0)", "inset(0 0% 0 0)"],
        opacity: [0.25, 1],
        transform: ["translateX(-5px) scale(0.96)", "translateX(0) scale(1)"],
      },
      { duration: 0.36, ease: EASE },
    );

    return () => animation.cancel();
  }, [animate, reducedMotion, scope]);

  return (
    <main
      className="bg-background fixed inset-0 z-40 grid place-items-center"
      aria-label="Starting Vibest"
    >
      <div
        ref={scope}
        className="vibest-startup-logo"
        style={{
          WebkitMaskImage: `url("${vibestLogoUrl}")`,
          maskImage: `url("${vibestLogoUrl}")`,
        }}
        aria-hidden="true"
      />
    </main>
  );
}
