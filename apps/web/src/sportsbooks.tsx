/* eslint-disable react-refresh/only-export-components */
import { useState } from "react";

const normalize = (value: string) =>
  value.toLowerCase().replace(/[^a-z0-9]+/g, "");

export const sportsbookScopeKey = normalize;

const sportsbookRegistry: Record<
  string,
  { readonly name: string; readonly logo: string }
> = {
  betmgm: { name: "BetMGM", logo: "/sportsbooks/betmgm.svg" },
  circa: { name: "Circa Sports", logo: "/sportsbooks/circa.svg" },
  consensus: {
    name: "DK + Circa Consensus",
    logo: "/sportsbooks/consensus.svg",
  },
  draftkings: { name: "DraftKings", logo: "/sportsbooks/draftkings.svg" },
  fanduel: { name: "FanDuel", logo: "/sportsbooks/fanduel.svg" },
};

export function sportsbookMetadata(scope: string) {
  const key = normalize(scope);
  const registered =
    key === "consensus"
      ? sportsbookRegistry["consensus"]
      : sportsbookRegistry[key];
  return registered ?? { name: scope };
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
