import { InspectorIndicator } from "./components/indicator";
import { useInspectorEvents } from "./hooks/use-inspect-events";

export function Inspector() {
  /**
   * addEventListeners to binding machine events
   */
  useInspectorEvents();

  return <InspectorIndicator />;
}
