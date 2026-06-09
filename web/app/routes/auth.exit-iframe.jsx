import { useEffect } from "react";
import { useSearchParams } from "@remix-run/react";

/**
 * This route handles the "exit iframe" step of the traditional OAuth flow.
 * When an embedded app needs to do a full-page redirect for OAuth,
 * it can't do it from inside the iframe — this page uses App Bridge / top-level
 * navigation to redirect the parent window to the OAuth URL.
 */
export default function ExitIframe() {
  const [searchParams] = useSearchParams();
  const exitIframe = searchParams.get("exitIframe");

  useEffect(() => {
    if (exitIframe) {
      if (window.top) {
        window.top.location.href = exitIframe;
      }
    }
  }, [exitIframe]);

  return (
    <div style={{ padding: "2rem", fontFamily: "system-ui, sans-serif" }}>
      <p>Redirecionando para autenticação...</p>
    </div>
  );
}
