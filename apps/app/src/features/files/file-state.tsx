import { Button } from "@vibest/ui/components/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@vibest/ui/components/empty";
import { FileCodeIcon, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

export function FileState({
  title,
  children,
  onRetry,
  icon: Icon = FileCodeIcon,
  prominentIcon = false,
}: {
  title: string;
  children: ReactNode;
  onRetry?: () => void;
  icon?: LucideIcon;
  prominentIcon?: boolean;
}) {
  return (
    <Empty className="py-8 md:py-8">
      <EmptyHeader>
        <EmptyMedia className={prominentIcon ? "size-12" : undefined} variant="icon">
          <Icon className={prominentIcon ? "size-6" : undefined} />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{children}</EmptyDescription>
      </EmptyHeader>
      {onRetry ? (
        <EmptyContent>
          <Button onClick={onRetry} size="sm" variant="outline">
            Try again
          </Button>
        </EmptyContent>
      ) : null}
    </Empty>
  );
}
