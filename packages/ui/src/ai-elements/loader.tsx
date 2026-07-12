import { cn } from "@vibest/ui/lib/utils";
import type { HTMLAttributes } from "react";

type LoaderIconProps = {
  size?: number;
};

const LoaderIcon = ({ size = 16 }: LoaderIconProps) => (
  <svg
    height={size}
    strokeLinejoin="round"
    style={{ color: "currentcolor" }}
    viewBox="0 0 16 16"
    width={size}
  >
    <title>Loader</title>
    <g clipPath="url(#clip0_2393_1490)">
      <path d="M8 0V4" stroke="currentColor" strokeWidth="1.5" />
      <path d="M8 16V12" opacity="0.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M3.3 1.53L5.65 4.76" opacity="0.9" stroke="currentColor" strokeWidth="1.5" />
      <path d="M12.7 1.53L10.35 4.76" opacity="0.1" stroke="currentColor" strokeWidth="1.5" />
      <path d="M12.7 14.47L10.35 11.24" opacity="0.4" stroke="currentColor" strokeWidth="1.5" />
      <path d="M3.3 14.47L5.65 11.24" opacity="0.6" stroke="currentColor" strokeWidth="1.5" />
      <path d="M15.61 5.53L11.8 6.76" opacity="0.2" stroke="currentColor" strokeWidth="1.5" />
      <path d="M0.39 10.47L4.2 9.24" opacity="0.7" stroke="currentColor" strokeWidth="1.5" />
      <path d="M15.61 10.47L11.8 9.24" opacity="0.3" stroke="currentColor" strokeWidth="1.5" />
      <path d="M0.39 5.53L4.2 6.76" opacity="0.8" stroke="currentColor" strokeWidth="1.5" />
    </g>
    <defs>
      <clipPath id="clip0_2393_1490">
        <rect fill="white" height="16" width="16" />
      </clipPath>
    </defs>
  </svg>
);

export type LoaderProps = HTMLAttributes<HTMLDivElement> & {
  size?: number;
};

export const Loader = ({ className, size = 16, ...props }: LoaderProps) => (
  <div className={cn("inline-flex animate-spin items-center justify-center", className)} {...props}>
    <LoaderIcon size={size} />
  </div>
);
