import type { ComponentProps, ReactElement, ReactNode } from "react"

import { cn } from "../../lib/utils.ts"

export type ChatMemberEntry = {
  id: string
  name: ReactNode
  avatar?: ReactNode
  badges?: ReactNode
  action?: ReactNode
  dimmed?: boolean
}

export type ChatMemberListProps = ComponentProps<"ul"> & {
  members: readonly ChatMemberEntry[]
}

export function ChatMemberList({ members, className, ...props }: ChatMemberListProps): ReactElement {
  return (
    <ul data-slot="chat-member-list" className={cn("m-0 flex list-none flex-col gap-2 p-0", className)} {...props}>
      {members.map((member) => (
        <li key={member.id} className="flex min-w-0 items-center gap-3">
          {member.avatar}
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1.5 gap-y-1">
            <span className={cn("truncate text-sm", member.dimmed ? "text-muted-foreground" : "font-medium")}>
              {member.name}
            </span>
            {member.badges}
          </div>
          {member.action}
        </li>
      ))}
    </ul>
  )
}

export type ChatMemberSectionProps = ChatMemberListProps & {
  label: string
  heading?: ReactNode
}

export function ChatMemberSection({ label, heading, members, ...props }: ChatMemberSectionProps): ReactElement | null {
  if (!members.length) return null

  return (
    <section aria-label={label} className="flex flex-col gap-4">
      {heading && <h3 className="m-0 flex items-center gap-2 font-medium text-muted-foreground text-xs">{heading}</h3>}
      <ChatMemberList members={members} {...props} />
    </section>
  )
}
