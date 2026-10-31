import React from 'react';
import { Alert, Button } from './ui';

interface Props {
  children: React.ReactNode;
}

interface State {
  error: Error | null;
}

/** Keeps one broken screen from taking down the till. */
export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('[renderer] unhandled error', error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="stack" style={{ maxWidth: 640 }}>
          <Alert tone="error">
            <div>
              <strong>This screen hit a problem.</strong>
              <div className="small" style={{ marginTop: 6 }}>
                {this.state.error.message}
              </div>
              <div className="small" style={{ marginTop: 6 }}>
                Your data is safe — nothing was saved by the failed action.
              </div>
            </div>
          </Alert>
          <div className="row tight">
            <Button onClick={() => this.setState({ error: null })}>Try again</Button>
            <Button variant="ghost" onClick={() => window.location.reload()}>
              Reload app
            </Button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
