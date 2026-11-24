import type { ReactElement, ReactNode } from "react"

import { type ChatMemberEntry, ChatMemberSection } from "./chat-members.tsx"
import { ChatMessageFooter } from "./chat-message-layout.tsx"

export type ChatMessageInfoProps = {
  message: ReactNode
  metadata: ReactNode
  groups: readonly {
    id: string
    label: string
    icon?: ReactNode
    members: readonly ChatMemberEntry[]
  }[]
}

export function ChatMessageInfo({ message, metadata, groups }: ChatMessageInfoProps): ReactElement {
  return (
    <div data-slot="chat-message-info">
      <div className="mb-7 flex flex-col items-end gap-1">
        <div className="w-fit min-w-0 max-w-[83%]">{message}</div>
        <ChatMessageFooter>{metadata}</ChatMessageFooter>
      </div>
      <div className="flex flex-col gap-7">
        {groups.map((group) => (
          <ChatMemberSection
            key={group.id}
            label={group.label}
            heading={
              <>
                {group.icon}
                {group.label}
              </>
            }
            members={group.members}
          />
        ))}
      </div>
    </div>
  )
}
