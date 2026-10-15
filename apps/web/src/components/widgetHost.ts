import { createContext } from "react";

// What the conversation page lends the interactive blocks in a reply. It lives in its own module so
// the component-program blocks (Widget.tsx) and the declarative streaming blocks (streamui/) can both
// use it without importing each other.

/** A block that broke, was cut off or needed fixing, so reflection can learn from it. */
export interface WidgetIssue {
  key: string;
  runId: string;
  title: string;
  kind: "error" | "dropped" | "diagnostics" | "interrupted";
  detail: string;
}

/** What the conversation page lends interactive blocks: sending a message, and the saved block states. */
export interface WidgetHost {
  conversationId: string;
  send: (text: string) => Promise<void>;
  /** Saved states by block key; undefined while loading. */
  states: Record<string, Record<string, unknown>> | undefined;
  saveState: (key: string, data: Record<string, unknown>) => void;
  /** Records a block that broke, was cut off or needed fixing, so reflection can learn from it. */
  reportIssue?: (issue: WidgetIssue) => void;
}

export const HostContext = createContext<WidgetHost | null>(null);
export const WidgetHostProvider = HostContext.Provider;
