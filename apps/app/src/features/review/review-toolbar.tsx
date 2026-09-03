import type { GitBranch, GitReviewMode } from "@vibest/contract/git";
import { Button } from "@vibest/ui/components/button";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@vibest/ui/components/select";
import { cn } from "@vibest/ui/lib/utils";
import { ChevronDownIcon, RefreshCwIcon } from "lucide-react";
import type { ComponentProps } from "react";

import { REVIEW_MODE_ITEMS, splitCompareRefs } from "./review-file-status";

function GhostSelectTrigger({
  className,
  placeholder,
  ...props
}: Omit<ComponentProps<typeof SelectTrigger>, "render"> & {
  placeholder?: string;
}) {
  // Drop SelectTrigger's field chrome and its hard-coded up/down icon.
  return (
    <SelectTrigger
      {...props}
      render={({ children: _children, className: _className, ...triggerProps }) => (
        <Button
          {...triggerProps}
          className={cn("min-w-0 gap-1 px-2 font-normal", className)}
          size="sm"
          variant="ghost"
        >
          <SelectValue placeholder={placeholder} />
          <ChevronDownIcon aria-hidden="true" className="size-3.5 shrink-0 opacity-70" />
        </Button>
      )}
    />
  );
}

export function ReviewToolbar({
  mode,
  other,
  branch,
  heading,
  refreshing,
  onModeChange,
  onOtherChange,
  onRefresh,
}: {
  mode: GitReviewMode;
  other: string | undefined;
  branch: GitBranch | undefined;
  heading: string;
  refreshing: boolean;
  onModeChange: (mode: GitReviewMode) => void;
  onOtherChange: (other: string) => void;
  onRefresh: () => void;
}) {
  const refs = splitCompareRefs(branch?.branches ?? [], branch?.remotes ?? []);
  const otherValue = other ?? branch?.defaultBranch ?? null;
  const otherItems = (branch?.branches ?? []).map((name) => ({ label: name, value: name }));

  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <Select
        items={[...REVIEW_MODE_ITEMS]}
        onValueChange={(next) => {
          if (next === "uncommitted" || next === "committed" || next === "branch") {
            onModeChange(next);
          }
        }}
        value={mode}
      >
        <GhostSelectTrigger aria-label="Compare mode" className="w-auto shrink-0" />
        <SelectContent alignItemWithTrigger={false}>
          {REVIEW_MODE_ITEMS.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {mode === "branch" ? (
        <Select
          disabled={branch === undefined || otherItems.length === 0}
          items={otherItems}
          onValueChange={(next) => {
            if (typeof next === "string") onOtherChange(next);
          }}
          value={otherValue}
        >
          <GhostSelectTrigger
            aria-label="Compare with branch"
            className="min-w-0 flex-1"
            placeholder="Select a branch"
          />
          <SelectContent alignItemWithTrigger={false}>
            {refs.local.length > 0 ? (
              <SelectGroup>
                <SelectGroupLabel>Local</SelectGroupLabel>
                {refs.local.map((name) => (
                  <SelectItem key={name} value={name}>
                    {name}
                  </SelectItem>
                ))}
              </SelectGroup>
            ) : null}
            {refs.remote.length > 0 ? (
              <SelectGroup>
                <SelectGroupLabel>Remote</SelectGroupLabel>
                {refs.remote.map((name) => (
                  <SelectItem key={name} value={name}>
                    {name}
                  </SelectItem>
                ))}
              </SelectGroup>
            ) : null}
          </SelectContent>
        </Select>
      ) : (
        <p className="text-muted-foreground min-w-0 flex-1 truncate text-xs" title={heading}>
          {heading}
        </p>
      )}
      <Button
        aria-label="Reload review"
        className="shrink-0"
        disabled={refreshing}
        onClick={onRefresh}
        size="icon-xs"
        variant="ghost"
      >
        <RefreshCwIcon className={cn("size-3.5", refreshing && "animate-spin")} />
      </Button>
    </div>
  );
}
