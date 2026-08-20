# Edge Case Hunter Review Prompt

Invoke the `bmad-review-edge-case-hunter` skill on this diff. Review from `/Users/kevishie/Projects/find-the-edge-codex-login-back` and report only unhandled edge cases with file and line references.

The approved spec is the untracked file `_bmad-output/implementation-artifacts/spec-login-root-back-chevron.md`; read it in full as part of the diff. The baseline is `5cf7c20053d2a08dfa51913e391899a5dc7e26b8`.

```diff
diff --git a/apps/web/src/App.tsx b/apps/web/src/App.tsx
@@ function SignInRoute() {
       <SignInScreen
         client={useContext(GamesClientContext)}
         store={useContext(SessionContext)}
         from={returnUrl}
+        homeLink={
+          <Link to="/" className="sign-in-back" aria-label="Back to home">
+            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
+              <path d="m15 18-6-6 6-6" />
+            </svg>
+          </Link>
+        }
         onSignedIn={(path) => router.history.replace(path)}

diff --git a/apps/web/src/sign-in.tsx b/apps/web/src/sign-in.tsx
@@
-import { useEffect, useRef, useState } from "react";
+import { useEffect, useRef, useState, type ReactNode } from "react";
@@
+  homeLink,
@@
+  readonly homeLink?: ReactNode;
@@
   return (
     <main className="sign-in-page">
+      {homeLink}
       <section className="sign-in-card" aria-labelledby="sign-in-heading">

diff --git a/apps/web/src/styles.css b/apps/web/src/styles.css
@@
 .sign-in-page {
+  position: relative;
   display: flex;
   align-items: center;
   justify-content: center;
+  width: 100%;
+  max-width: none;
   min-height: 100vh;
+  margin: 0;
   padding: 24px 16px;
 }
+.sign-in-back {
+  position: absolute;
+  top: 24px;
+  left: 24px;
+  display: grid;
+  width: 44px;
+  height: 44px;
+  place-items: center;
+  border: 1px solid #302b39;
+  border-radius: 10px;
+  color: #c4b5fd;
+  background: rgba(14, 13, 19, 0.88);
+  text-decoration: none;
+  transition: border-color 0.15s ease, color 0.15s ease, background 0.15s ease;
+}
+.sign-in-back svg {
+  width: 24px;
+  height: 24px;
+  fill: none;
+  stroke: currentColor;
+  stroke-width: 2;
+  stroke-linecap: round;
+  stroke-linejoin: round;
+}
+.sign-in-back:hover {
+  border-color: #8b5cf6;
+  color: #f3f1f8;
+  background: rgba(124, 58, 237, 0.18);
+}
+.sign-in-back:focus-visible {
+  outline: 2px solid #c4b5fd;
+  outline-offset: 3px;
+}
+@media (max-width: 560px) {
+  .sign-in-back { top: 16px; left: 16px; }
+}

diff --git a/apps/web/src/sign-in.test.tsx b/apps/web/src/sign-in.test.tsx
@@
+it("returns from sign-in to the root landing page instead of the return URL", async () => {
+  render(<App initialPath="/login?returnUrl=%2Fsplits" sessionStore={store()} />);
+  const backHome = await screen.findByRole("link", { name: "Back to home" });
+  expect(backHome).toHaveAttribute("href", "/");
+  fireEvent.click(backHome);
+  expect(await screen.findByRole("heading", { name: /Stop shopping lines/i })).toBeVisible();
+  expect(screen.queryByRole("heading", { name: "Sign in" })).toBeNull();
+});
```

Explicitly inspect direct `/login`, `/login?returnUrl=...`, phone and code steps, narrow/short viewports, keyboard focus, reduced motion, router navigation, semantic link naming, and layout interaction with the centered card.

Verification already run: all 441 web tests passed, web TypeScript passed, web lint passed, and desktop/mobile screenshots were visually inspected.
