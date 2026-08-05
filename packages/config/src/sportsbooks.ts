export type CanonicalSportsbookId =
  | "hardrock"
  | "draftkings"
  | "fanduel"
  | "betmgm"
  | "caesars"
  | "pinnacle"
  | "ballybet"
  | "betano"
  | "fanatics"
  | "fanatics_markets"
  | "betrivers"
  | "betonline"
  | "bovada"
  | "fliff"
  | "kalshi"
  | "novig"
  | "onexbet"
  | "polymarket"
  | "prophetx"
  | "sbobet"
  | "stake"
  | "thescorebet"
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
      id: "pinnacle",
      name: "Pinnacle",
      aliases: ["pinnacle", "pinnacle sports", "pinnaclesports"],
    },
    {
      id: "ballybet",
      name: "Bally Bet",
      aliases: ["ballybet", "bally bet"],
    },
    {
      id: "betano",
      name: "Betano",
      aliases: ["betano"],
    },
    {
      id: "fanatics",
      name: "Fanatics Sportsbook",
      aliases: ["fanatics", "fanatics sportsbook", "fanaticssportsbook"],
    },
    {
      id: "fanatics_markets",
      name: "Fanatics Markets",
      aliases: ["fanatics_markets", "fanatics markets"],
    },
    {
      id: "betrivers",
      name: "BetRivers",
      aliases: ["betrivers", "bet rivers", "bet-rivers"],
    },
    {
      id: "betonline",
      name: "BetOnline",
      aliases: ["betonline", "bet online", "betonline.ag"],
    },
    {
      id: "bovada",
      name: "Bovada",
      aliases: ["bovada", "bovada.lv"],
    },
    {
      id: "fliff",
      name: "Fliff",
      aliases: ["fliff"],
    },
    {
      id: "kalshi",
      name: "Kalshi",
      aliases: ["kalshi"],
    },
    { id: "novig", name: "Novig", aliases: ["novig", "no vig"] },
    { id: "onexbet", name: "1xBet", aliases: ["onexbet", "1xbet"] },
    {
      id: "polymarket",
      name: "Polymarket",
      aliases: ["polymarket"],
    },
    { id: "prophetx", name: "ProphetX", aliases: ["prophetx", "prophet x"] },
    { id: "sbobet", name: "SBOBET", aliases: ["sbobet", "sbo bet"] },
    { id: "stake", name: "Stake", aliases: ["stake", "stake.com"] },
    {
      id: "thescorebet",
      name: "theScore Bet",
      aliases: ["thescorebet", "the score bet"],
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

const byAlias = new Map<string, SportsbookRegistration>();
const canonicalIds = new Set<string>();
for (const book of sportsbookRegistry) {
  if (canonicalIds.has(book.id)) throw new Error("duplicate-sportsbook-id");
  canonicalIds.add(book.id);
  for (const alias of [book.id, ...book.aliases]) {
    const normalized = token(alias);
    if (!normalized) throw new Error("empty-sportsbook-alias");
    const existing = byAlias.get(normalized);
    if (existing && existing.id !== book.id)
      throw new Error("conflicting-sportsbook-alias");
    byAlias.set(normalized, book);
  }
}

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

/** Closed allowlist for licensed odds collection; independent of evaluation. */
export const approvedSportsbookCollection = Object.freeze({
  hardrock: "offered",
  draftkings: "comparison",
  fanduel: "comparison",
  betmgm: "comparison",
  caesars: "comparison",
  pinnacle: "collected",
  circa: "collected",
  ballybet: "collected",
  betano: "collected",
  fanatics: "collected",
  fanatics_markets: "collected",
  betrivers: "collected",
  betonline: "collected",
  bovada: "collected",
  fliff: "collected",
  kalshi: "collected",
  novig: "collected",
  onexbet: "collected",
  polymarket: "collected",
  prophetx: "collected",
  sbobet: "collected",
  stake: "collected",
  thescorebet: "collected",
} as const);
