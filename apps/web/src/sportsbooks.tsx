/* eslint-disable react-refresh/only-export-components */
import { useState } from "react";
import { normalizeSportsbook } from "@find-the-edge/config";

const normalize = (value: string) =>
  value.toLowerCase().replace(/[^a-z0-9]+/g, "");

export const sportsbookScopeKey = (value: string) => {
  const result = normalizeSportsbook(value);
  return result.kind === "normalized" ? result.sportsbook.id : normalize(value);
};

export function sportsbookMetadata(scope: string) {
  const result = normalizeSportsbook(scope);
  return result.kind === "normalized"
    ? {
        name: result.sportsbook.name,
        ...(result.sportsbook.logo ? { logo: result.sportsbook.logo } : {}),
      }
    : { name: scope };
}

export function SportsbookLogo({ scope }: { readonly scope: string }) {
  const book = sportsbookMetadata(scope);
  const [failedLogo, setFailedLogo] = useState<string>();
  if ("logo" in book && failedLogo !== book.logo)
    return (
      <img
        className="sportsbook-logo"
        src={book.logo}
        alt={book.name}
        onError={() => setFailedLogo(book.logo)}
      />
    );
  return (
    <span className="sportsbook-fallback" aria-hidden="true">
      {book.name
        .split(/\s+/)
        .map((part) => part[0])
        .join("")
        .slice(0, 3)
        .toUpperCase() || "?"}
    </span>
  );
}
