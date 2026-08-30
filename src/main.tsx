import { TDSMobileAITProvider } from "@toss/tds-mobile-ait";
import { Component, StrictMode, type ErrorInfo, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

import App from "./App.tsx";
import { BRAND_PRIMARY_COLOR } from "./constants/brand.ts";
import { migrateOriginLocalStorage } from "./services/originStorageMigration.ts";
import "./index.css";

class AppErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("App crashed", error, info);
  }

  render() {
    if (this.state.error !== null) {
      return (
        <pre
          style={{
            margin: 16,
            padding: 16,
            whiteSpace: "pre-wrap",
            background: "#fff",
            color: "#d00",
          }}
        >
          {`${this.state.error.name}: ${this.state.error.message}`}
        </pre>
      );
    }

    return this.props.children;
  }
}

async function bootstrap() {
  await migrateOriginLocalStorage();

  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <AppErrorBoundary>
        <TDSMobileAITProvider brandPrimaryColor={BRAND_PRIMARY_COLOR}>
          <App />
        </TDSMobileAITProvider>
      </AppErrorBoundary>
    </StrictMode>,
  );
}

void bootstrap();
