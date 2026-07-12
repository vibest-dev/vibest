import { CollapsibleUserText } from "@vibest/ui/ai-elements/collapsible-user-text";
import { Message, MessageContent } from "@vibest/ui/ai-elements/message";

import type { ClaudeCodeUIMessage } from "@/types";

export function UserMessage({ message }: { message: ClaudeCodeUIMessage }) {
  return (
    <>
      {message.parts.map((part, index) =>
        part.type === "text" ? (
          <Message key={index} from="user">
            <MessageContent>
              <CollapsibleUserText text={part.text} />
            </MessageContent>
          </Message>
        ) : null,
      )}
    </>
  );
}
