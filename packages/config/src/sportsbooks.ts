export type CanonicalSportsbookId =
  | "hardrock"
  | "draftkings"
  | "fanduel"
  | "betmgm"
  | "caesars"
  | "circa"
  | "consensus";
export type ProductionSportsbookRole = "offered" | "comparison";

export interface SportsbookRegistration {
  readonly id: CanonicalSportsbookId;
  readonly name: string;
  readonly logo?: string;
  readonly aliases: readonly string[];
  readonly productionRole?: ProductionSportsbookRole;
}

const token = (value: string) =>
  value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");

export const sportsbookRegistry: readonly SportsbookRegistration[] =
  Object.freeze([
    {
      id: "hardrock",
      name: "Hard Rock Bet",
      logo: "/sportsbooks/hardrock.svg",
      aliases: ["hardrock", "hardrockbet", "hard rock bet", "hard-rock-bet"],
      productionRole: "offered",
    },
    {
      id: "draftkings",
      name: "DraftKings",
      logo: "/sportsbooks/draftkings.svg",
      aliases: ["draftkings", "draft kings", "dk"],
      productionRole: "comparison",
    },
    {
      id: "fanduel",
      name: "FanDuel",
      logo: "/sportsbooks/fanduel.svg",
      aliases: ["fanduel", "fan duel"],
      productionRole: "comparison",
    },
    {
      id: "betmgm",
      name: "BetMGM",
      logo: "/sportsbooks/betmgm.svg",
      aliases: ["betmgm", "bet mgm", "mgm"],
      productionRole: "comparison",
    },
    {
      id: "caesars",
      name: "Caesars Sportsbook",
      logo: "/sportsbooks/caesars.svg",
      aliases: ["caesars", "caesars sportsbook", "williamhill", "william hill"],
      productionRole: "comparison",
    },
    {
      id: "circa",
      name: "Circa Sports",
      logo: "/sportsbooks/circa.svg",
      aliases: ["circa", "circa sports"],
    },
    {
      id: "consensus",
      name: "DK + Circa Consensus",
      logo: "/sportsbooks/consensus.svg",
      aliases: ["consensus"],
    },
  ]);

const byAlias = new Map(
  sportsbookRegistry.flatMap((book) =>
    [book.id, ...book.aliases].map((alias) => [token(alias), book] as const),
  ),
);

export type SportsbookNormalization =
  | { readonly kind: "normalized"; readonly sportsbook: SportsbookRegistration }
  | {
      readonly kind: "rejected";
      readonly reason: "unknown-bookmaker";
      readonly auditId: string;
    };

export function normalizeSportsbook(value: string): SportsbookNormalization {
  const auditId = token(value).slice(0, 64) || "unknown";
  const sportsbook = byAlias.get(auditId);
  return sportsbook
    ? { kind: "normalized", sportsbook }
    : { kind: "rejected", reason: "unknown-bookmaker", auditId };
}

export const productionSportsbookRoles = Object.freeze(
  Object.fromEntries(
    sportsbookRegistry.flatMap((book) =>
      book.productionRole ? [[book.id, book.productionRole]] : [],
    ),
  ) as Readonly<Record<string, ProductionSportsbookRole>>,
);
