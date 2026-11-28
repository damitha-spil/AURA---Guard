// Keeps one broken page or panel from blanking the whole window.
import * as React from "react";
import { TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";

interface Props {
  children: React.ReactNode;
  /** What failed, in plain words: "This page". */
  what: string;
  /** Replaces the message, for decoration that can simply disappear. */
  fallback?: React.ReactNode;
}

export class ErrorBoundary extends React.Component<Props, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback !== undefined) return this.props.fallback;
    return (
      <div role="alert" className="m-auto flex max-w-lg flex-col items-center gap-3 p-8 text-center">
        <TriangleAlert className="text-destructive size-6" />
        <h2 className="text-lg font-semibold">{this.props.what} stopped working</h2>
        <p className="text-muted-foreground text-sm">Try again, or reload the window.</p>
        <pre className="bg-muted max-h-32 w-full overflow-auto rounded-md p-2 text-left text-xs break-words whitespace-pre-wrap">{error.message}</pre>
        <div className="flex gap-2">
          <Button size="sm" onClick={() => this.setState({ error: null })}>Try again</Button>
          <Button size="sm" variant="outline" onClick={() => window.location.reload()}>Reload window</Button>
        </div>
      </div>
    );
  }
}
