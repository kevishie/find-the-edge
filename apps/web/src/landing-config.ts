const safeInternalPath = (value: string | undefined) =>
  value?.startsWith("/") && !value.startsWith("//") ? value : null;

export const landingConfig = {
  authPath: safeInternalPath(import.meta.env.VITE_PUBLIC_AUTH_PATH),
} as const;
