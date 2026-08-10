const safeInternalPath = (value: unknown) =>
  typeof value === "string" && value.startsWith("/") && !value.startsWith("//")
    ? value
    : null;

export const landingConfig = {
  authPath: safeInternalPath(import.meta.env.VITE_PUBLIC_AUTH_PATH),
} as const;
