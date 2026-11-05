import { Component, type ErrorInfo, type ReactNode } from "react";
import type { UiStrings } from "../ui/strings.ts";

interface Props {
  readonly strings: UiStrings;
  readonly children: ReactNode;
}

interface State {
  readonly error: Error | null;
}

/**
 * Last line of defence: a render error anywhere shows this page instead of an empty
 * window. Autosave has already written the recovery cache, so a reload offers to restore.
 * The message is rendered as text, never as HTML.
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error(error, info.componentStack);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (error === null) return this.props.children;
    const s = this.props.strings.crash;
    return (
      <main className="crash" role="alert">
        <h1>{s.title}</h1>
        <p>{s.body}</p>
        <button type="button" onClick={() => location.reload()}>
          {s.reload}
        </button>
        <details>
          <summary>{s.details}</summary>
          <pre>{error.message}</pre>
        </details>
      </main>
    );
  }
}
