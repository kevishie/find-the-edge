const safeInternalPath = (value: unknown) =>
  typeof value === "string" && value.startsWith("/") && !value.startsWith("//")
    ? value
    : null;

export const landingConfig = {
  // The sign-in form is a route this app serves, so the landing page links to
  // it directly. The env override remains for a stage that points elsewhere,
  // and is still validated as an on-origin path.
  authPath: safeInternalPath(import.meta.env.VITE_PUBLIC_AUTH_PATH) ?? "/login",
} as const;
