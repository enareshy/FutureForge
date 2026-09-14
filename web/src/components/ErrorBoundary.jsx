import React from "react";

// Catches render-time errors anywhere below it so a single broken view shows a
// readable message (and a way back) instead of an empty screen.
export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // Surface for the browser console / future telemetry.
    console.error("Helix UI error:", error, info);
  }

  reset = () => this.setState({ error: null });

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="panel" style={{ margin: 24 }}>
        <h3>Something went wrong rendering this view</h3>
        <p className="sub">
          The rest of the console is still available. You can retry, or use the navigation to open another page.
        </p>
        <pre className="mono json" style={{ marginTop: 12 }}>
          {String(this.state.error?.stack || this.state.error?.message || this.state.error)}
        </pre>
        <div className="inline" style={{ marginTop: 12 }}>
          <button type="button" className="btn" onClick={this.reset}>Retry</button>
          <button type="button" className="btn ghost" onClick={() => { this.reset(); window.location.assign("/"); }}>
            Go to overview
          </button>
        </div>
      </div>
    );
  }
}
