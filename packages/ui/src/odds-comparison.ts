import type { GameOddsComparisonDto } from "@find-the-edge/domain";

export interface OddsComparisonViewModel {
  readonly targetQualified: boolean;
  readonly books: GameOddsComparisonDto["oddsComparison"]["sportsbooks"];
  readonly markets: readonly {
    readonly key: string;
    readonly label: string;
    readonly selections: readonly {
      readonly key: string;
      readonly label: string;
      readonly cells: readonly {
        readonly bookId: string;
        readonly stateLabel: string;
        readonly best: boolean;
        readonly cell: GameOddsComparisonDto["oddsComparison"]["markets"][number]["selections"][number]["cells"][string];
      }[];
    }[];
  }[];
}

const marketLabel = (key: string) =>
  key === "moneyline"
    ? "Moneyline"
    : key === "spread"
      ? "Spread"
      : key === "total"
        ? "Total"
        : key;

const betterCell = <
  T extends {
    readonly point?: number;
    readonly americanOdds: number;
  },
>(
  marketKey: string,
  selectionKey: string,
  left: T,
  right: T,
): T => {
  if (marketKey !== "moneyline" && left.point !== right.point) {
    if (left.point === undefined) return right;
    if (right.point === undefined) return left;
    if (marketKey === "total" && selectionKey === "over")
      return left.point < right.point ? left : right;
    return left.point > right.point ? left : right;
  }
  return left.americanOdds >= right.americanOdds ? left : right;
};

export function buildOddsComparisonViewModel(
  detail: GameOddsComparisonDto,
): OddsComparisonViewModel {
  const target = detail.oddsComparison.targetSportsbookId;
  const books = [...detail.oddsComparison.sportsbooks].sort(
    (a, b) =>
      Number(b.id === target) - Number(a.id === target) ||
      a.label.localeCompare(b.label),
  );
  return {
    targetQualified: detail.oddsComparison.targetQualified,
    books,
    markets: detail.oddsComparison.markets.map((market) => ({
      key: market.marketKey,
      label: marketLabel(market.marketKey),
      selections: market.selections.map((selection) => {
        const eligible = Object.values(selection.cells).filter(
          (cell) => cell.eligible,
        );
        const best = eligible.reduce<(typeof eligible)[number] | undefined>(
          (winner, cell) =>
            winner
              ? betterCell(
                  market.marketKey,
                  selection.selectionKey,
                  winner,
                  cell,
                )
              : cell,
          undefined,
        );
        return {
          key: selection.selectionKey,
          label: selection.selectionLabel,
          cells: books.map((book) => {
            const cell = selection.cells[book.id]!;
            return {
              bookId: book.id,
              stateLabel:
                cell.state === "active"
                  ? "Active"
                  : cell.state === "stale"
                    ? "Stale"
                    : cell.state === "suspended"
                      ? "Suspended"
                      : cell.state === "partial"
                        ? "Partial"
                        : "Unavailable",
              best:
                cell.eligible &&
                best !== undefined &&
                cell.point === best.point &&
                cell.americanOdds === best.americanOdds,
              cell,
            };
          }),
        };
      }),
    })),
  };
}
