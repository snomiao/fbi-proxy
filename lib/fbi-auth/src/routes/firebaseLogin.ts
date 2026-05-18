import { Hono } from "hono";

export type FirebaseLoginOpts = {
  ssoOrigin: string;
  domain: string;
  firebaseConfig: {
    apiKey: string;
    authDomain: string;
    projectId: string;
  };
};

export function firebaseLoginRoute(opts: FirebaseLoginOpts): Hono {
  const app = new Hono();

  app.get("/login", (c) => {
    const rd = c.req.query("rd") ?? `${opts.ssoOrigin}/api/auth/me`;
    if (!isSafeRd(rd, opts.ssoOrigin)) {
      return c.text("invalid rd", 400);
    }
    return c.html(renderLoginPage(opts, rd));
  });

  return app;
}

function isSafeRd(rd: string, ssoOrigin: string): boolean {
  try {
    const u = new URL(rd);
    const sso = new URL(ssoOrigin);
    const ssoApex = sso.hostname.replace(/^sso\./, "");
    return u.hostname === sso.hostname || u.hostname.endsWith(`.${ssoApex}`);
  } catch {
    return false;
  }
}

function renderLoginPage(opts: FirebaseLoginOpts, rd: string): string {
  const cfg = JSON.stringify(opts.firebaseConfig);
  const safeRd = JSON.stringify(rd);
  const domainText = escapeHtml(opts.domain);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Sign in to ${domainText}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
         max-width: 24rem; margin: 4rem auto; padding: 0 1rem; text-align: center; }
  h1 { font-weight: 600; font-size: 1.4rem; margin-bottom: 0.25rem; }
  p.subtitle { opacity: 0.7; margin-top: 0; }
  button { font-size: 1rem; padding: 0.6rem 1.2rem; border-radius: 0.5rem;
           border: 1px solid currentColor; background: transparent; color: inherit;
           cursor: pointer; }
  button:hover { background: rgba(127,127,127,0.1); }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  #status { margin-top: 1rem; min-height: 1.5em; opacity: 0.8; font-size: 0.9rem; }
  #status.error { color: #c00; }
  code { background: rgba(127,127,127,0.15); padding: 0.1em 0.3em; border-radius: 0.25em; }
</style>
</head>
<body>
<main>
  <h1>Sign in to ${domainText}</h1>
  <p class="subtitle">fbi-auth · snolab default IdP</p>
  <button id="signin" type="button">Sign in with Google</button>
  <p id="status"></p>
</main>
<script type="module">
  import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js";
  import { getAuth, GoogleAuthProvider, signInWithPopup } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";

  const firebaseConfig = ${cfg};
  const rd = ${safeRd};

  const app = initializeApp(firebaseConfig);
  const auth = getAuth(app);
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });

  const btn = document.getElementById("signin");
  const status = document.getElementById("status");

  function setError(msg) {
    status.textContent = msg;
    status.classList.add("error");
    btn.disabled = false;
  }
  function setStatus(msg) {
    status.textContent = msg;
    status.classList.remove("error");
  }

  btn.addEventListener("click", async () => {
    btn.disabled = true;
    setStatus("Opening Google sign-in…");
    try {
      const result = await signInWithPopup(auth, provider);
      const idToken = await result.user.getIdToken();
      setStatus("Verifying…");
      const res = await fetch("/api/auth/firebase", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idToken }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: res.statusText }));
        setError(body.error || ("HTTP " + res.status));
        return;
      }
      setStatus("Signed in. Redirecting…");
      window.location.href = rd;
    } catch (err) {
      setError(err && err.message ? err.message : String(err));
    }
  });
</script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
