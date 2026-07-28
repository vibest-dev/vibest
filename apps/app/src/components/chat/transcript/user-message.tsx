import { CollapsibleUserText } from "@vibest/ui/ai-elements/collapsible-user-text";
import { Message, MessageContent } from "@vibest/ui/ai-elements/message";
import type { UIMessage } from "ai";

export function UserMessage({ message }: { message: UIMessage }) {
  return (
    <>
      {message.parts.map((part, index) =>
        part.type === "text" ? (
          // A user message is built once at submit time and never streamed, so
          // `parts` is a frozen array that cannot reorder or filter. Text parts
          // carry no id of their own, which leaves the position as the only key.
          // react-doctor-disable-next-line no-array-index-as-key
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
