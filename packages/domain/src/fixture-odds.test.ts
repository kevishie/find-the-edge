import { describe, expect, it } from "vitest";

import {
  FixtureOddsInputError,
  FixtureOddsStateCorruptionError,
  normalizeFixtureOddsObservation,
  sha256Hex,
  transitionFixtureOdds,
  type FixtureOddsObservation,
  type FixtureOddsState,
} from "./fixture-odds.js";

const base = (
  overrides: Partial<FixtureOddsObservation> = {},
): FixtureOddsObservation => ({
  canonicalEventId: "event:mlb:1",
  canonicalEventVersion: 7,
  sportKey: "baseball",
  marketKey: "moneyline",
  selectionKey: "home",
  selectionLabel: "New York",
  sportsbookId: "fixture-book",
  sportsbookLabel: "Fixture Book",
  americanOdds: -110,
  observedAt: "2026-08-01T12:00:00Z",
  retrievedAt: "2026-08-01T12:00:01Z",
  ...overrides,
});

describe("fixture odds normalization", () => {
  it("implements the standard SHA-256 vector without Node-only modules", () => {
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("is deterministic and canonicalizes timezone offsets", () => {
    const utc = normalizeFixtureOddsObservation(base());
    const offset = normalizeFixtureOddsObservation(
      base({ observedAt: "2026-08-01T08:00:00-04:00" }),
    );
    expect(offset).toEqual(utc);
    expect(utc.snapshotId).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.isFrozen(utc)).toBe(true);
  });

  it("preserves provider policy provenance and rejects fabricated source states", () => {
    const snapshot = normalizeFixtureOddsObservation(
      base({
        provenance: {
          providerId: "sharpapi",
          policyVersion: "2026-08-03.control-plane.v1",
          bookRole: "offered",
          sourceState: "active",
        },
      }),
    );
    expect(snapshot.provenance).toEqual({
      providerId: "sharpapi",
      policyVersion: "2026-08-03.control-plane.v1",
      bookRole: "offered",
      sourceState: "active",
    });
    expect(() =>
      normalizeFixtureOddsObservation(
        base({
          provenance: {
            providerId: "sharpapi",
            policyVersion: "v1",
            bookRole: "offered",
            sourceState: "active",
            fabricated: true,
          } as never,
        }),
      ),
    ).toThrow(FixtureOddsInputError);
  });

  it("selects Sharp once for a shared-book tie while retaining both provider snapshots", () => {
    const fallback = base({
      provenance: {
        providerId: "the-odds-api",
        policyVersion: "v1",
        bookRole: "offered",
        sourceState: "active",
      },
    });
    const primary = base({
      americanOdds: -111,
      provenance: {
        providerId: "sharpapi",
        policyVersion: "v1",
        bookRole: "offered",
        sourceState: "active",
      },
    });
    const first = transitionFixtureOdds(undefined, fallback);
    const selected = transitionFixtureOdds(first.state, primary);
    expect(selected.state.currentSnapshotId).toBe(
      normalizeFixtureOddsObservation(primary).snapshotId,
    );
    expect(Object.keys(selected.state.snapshots)).toHaveLength(2);
  });

  it("uses an unambiguous, versioned canonical-array partition", () => {
    const first = normalizeFixtureOddsObservation(
      base({ canonicalEventId: "a:b", sportKey: "c" }),
    );
    const second = normalizeFixtureOddsObservation(
      base({ canonicalEventId: "a", sportKey: "b:c" }),
    );
    const version = normalizeFixtureOddsObservation(
      base({ canonicalEventVersion: 8 }),
    );
    expect(first.partitionKey).not.toBe(second.partitionKey);
    expect(first.partitionKey).not.toBe(version.partitionKey);
    expect(
      JSON.parse(first.partitionKey.slice("FIXTURE_ODDS#".length)),
    ).toEqual(["a:b", 7, "c", "moneyline", "home", "fixture-book"]);
  });

  it.each([
    { canonicalEventId: "" },
    { sportKey: "bad\nkey" },
    { canonicalEventVersion: 0 },
    { canonicalEventVersion: 1.5 },
    { americanOdds: 99 },
    { americanOdds: 0 },
    { americanOdds: Number.NaN },
    { observedAt: "2026-08-01" },
    { observedAt: "not-a-date" },
    { observedAt: "2026-02-30T12:00:00Z" },
    { selectionLabel: "bad\u0000label" },
  ])("rejects invalid input %#", (override) => {
    expect(() => normalizeFixtureOddsObservation(base(override))).toThrow(
      FixtureOddsInputError,
    );
  });

  it("accepts exact identifier and label bounds and rejects one byte beyond", () => {
    expect(() =>
      normalizeFixtureOddsObservation(
        base({ marketKey: "m".repeat(128), selectionLabel: "é".repeat(128) }),
      ),
    ).not.toThrow();
    expect(() =>
      normalizeFixtureOddsObservation(base({ marketKey: "m".repeat(129) })),
    ).toThrow(FixtureOddsInputError);
    expect(() =>
      normalizeFixtureOddsObservation(
        base({ selectionLabel: "é".repeat(129) }),
      ),
    ).toThrow(FixtureOddsInputError);
  });

  it("rejects changing and throwing input getters without invoking them", () => {
    let reads = 0;
    const changing = { ...base() };
    Object.defineProperty(changing, "americanOdds", {
      enumerable: true,
      get: () => {
        reads += 1;
        return reads === 1 ? -110 : -120;
      },
    });
    expect(() => normalizeFixtureOddsObservation(changing)).toThrow(
      FixtureOddsInputError,
    );
    expect(reads).toBe(0);

    const throwing = { ...base() };
    Object.defineProperty(throwing, "observedAt", {
      enumerable: true,
      get: () => {
        throw new Error("must not run");
      },
    });
    expect(() => normalizeFixtureOddsObservation(throwing)).toThrow(
      FixtureOddsInputError,
    );
  });

  it("rejects explicitly undefined optional input labels as noncanonical", () => {
    const observation = { ...base(), selectionLabel: undefined };
    expect(() =>
      normalizeFixtureOddsObservation(
        observation as unknown as FixtureOddsObservation,
      ),
    ).toThrow(FixtureOddsInputError);
  });
});

describe("fixture odds transition", () => {
  it("creates, replays, and never mutates or aliases caller state", () => {
    const created = transitionFixtureOdds(undefined, base());
    const replay = transitionFixtureOdds(created.state, base());
    expect(created.snapshot).toBe("created");
    expect(replay.snapshot).toBe("existing");
    expect(replay.current).toBe("retained");
    expect(replay.state).not.toBe(created.state);
    expect(Object.isFrozen(replay.state)).toBe(true);
    expect(Object.isFrozen(replay.state.snapshots)).toBe(true);
  });

  it("retains older history and chooses newer CURRENT independent of insertion order", () => {
    const older = base({
      observedAt: "2026-08-01T11:00:00Z",
      americanOdds: -105,
    });
    const newer = base({
      observedAt: "2026-08-01T13:00:00Z",
      americanOdds: -115,
    });
    const newerThenOlder = transitionFixtureOdds(
      transitionFixtureOdds(undefined, newer).state,
      older,
    );
    const olderThenNewer = transitionFixtureOdds(
      transitionFixtureOdds(undefined, older).state,
      newer,
    );
    expect(newerThenOlder.current).toBe("retained");
    expect(Object.keys(newerThenOlder.state.snapshots)).toHaveLength(2);
    expect(newerThenOlder.state.currentSnapshotId).toBe(
      olderThenNewer.state.currentSnapshotId,
    );
  });

  it("converges for every ordering of three distinct observations", () => {
    const observations = [
      base({ observedAt: "2026-08-01T10:00:00Z", americanOdds: -101 }),
      base({ observedAt: "2026-08-01T12:00:00Z", americanOdds: -102 }),
      base({ observedAt: "2026-08-01T11:00:00Z", americanOdds: -103 }),
    ];
    const permutations = [
      [0, 1, 2],
      [0, 2, 1],
      [1, 0, 2],
      [1, 2, 0],
      [2, 0, 1],
      [2, 1, 0],
    ];
    const results = permutations.map((order) =>
      order.reduce<FixtureOddsState | undefined>(
        (state, index) =>
          transitionFixtureOdds(state, observations[index]!).state,
        undefined,
      ),
    );
    expect(
      results.every(
        (state) => state!.currentSnapshotId === results[0]!.currentSnapshotId,
      ),
    ).toBe(true);
    expect(
      results.every((state) => Object.keys(state!.snapshots).length === 3),
    ).toBe(true);
  });

  it("breaks equal observed-time ties with code-unit snapshot ID order", () => {
    const one = base({ americanOdds: -105 });
    const two = base({ americanOdds: -115 });
    const a = normalizeFixtureOddsObservation(one);
    const b = normalizeFixtureOddsObservation(two);
    const result = transitionFixtureOdds(
      transitionFixtureOdds(undefined, one).state,
      two,
    );
    expect(result.state.currentSnapshotId).toBe(
      a.snapshotId > b.snapshotId ? a.snapshotId : b.snapshotId,
    );
  });

  it("isolates every partition dimension, including canonical version", () => {
    const state = transitionFixtureOdds(undefined, base()).state;
    for (const override of [
      { canonicalEventId: "other" },
      { canonicalEventVersion: 8 },
      { sportKey: "soccer" },
      { marketKey: "spread" },
      { selectionKey: "away" },
      { sportsbookId: "other-book" },
    ]) {
      expect(() => transitionFixtureOdds(state, base(override))).toThrow(
        FixtureOddsStateCorruptionError,
      );
    }
  });

  it("rejects forged keys, mixed records, and stale CURRENT", () => {
    const first = transitionFixtureOdds(undefined, base()).state;
    const second = transitionFixtureOdds(
      first,
      base({ observedAt: "2026-08-01T13:00:00Z" }),
    ).state;
    const id = Object.keys(first.snapshots)[0]!;
    const forgedRecord = { ...first.snapshots[id]!, americanOdds: -120 };
    expect(() =>
      transitionFixtureOdds(
        { ...first, snapshots: { [id]: forgedRecord } },
        base(),
      ),
    ).toThrow(FixtureOddsStateCorruptionError);
    expect(() =>
      transitionFixtureOdds(
        { ...first, snapshots: { wrong: first.snapshots[id]! } },
        base(),
      ),
    ).toThrow(FixtureOddsStateCorruptionError);
    expect(() =>
      transitionFixtureOdds({ ...second, currentSnapshotId: id }, base()),
    ).toThrow(FixtureOddsStateCorruptionError);
  });

  it("rejects inherited snapshot collections and inherited required fields", () => {
    const state = transitionFixtureOdds(undefined, base()).state;
    const inheritedSnapshots = Object.create(
      state.snapshots,
    ) as FixtureOddsState["snapshots"];
    expect(() =>
      transitionFixtureOdds(
        { ...state, snapshots: inheritedSnapshots },
        base(),
      ),
    ).toThrow(FixtureOddsStateCorruptionError);
    const inheritedState = Object.create(state) as FixtureOddsState;
    expect(() => transitionFixtureOdds(inheritedState, base())).toThrow(
      FixtureOddsStateCorruptionError,
    );
  });

  it("rejects symbolic, hidden, accessor, and noncanonical optional state properties", () => {
    const state = transitionFixtureOdds(undefined, base()).state;
    const id = state.currentSnapshotId;

    const symbolicSnapshots = { ...state.snapshots };
    Object.defineProperty(symbolicSnapshots, Symbol("extra"), {
      enumerable: true,
      value: state.snapshots[id],
    });
    expect(() =>
      transitionFixtureOdds({ ...state, snapshots: symbolicSnapshots }, base()),
    ).toThrow(FixtureOddsStateCorruptionError);

    const hiddenPartition = { ...state.partition };
    Object.defineProperty(hiddenPartition, "hidden", {
      enumerable: false,
      value: "extra",
    });
    expect(() =>
      transitionFixtureOdds({ ...state, partition: hiddenPartition }, base()),
    ).toThrow(FixtureOddsStateCorruptionError);

    let getterReads = 0;
    const accessorRecord = { ...state.snapshots[id]! };
    Object.defineProperty(accessorRecord, "americanOdds", {
      enumerable: true,
      get: () => {
        getterReads += 1;
        return -110;
      },
    });
    expect(() =>
      transitionFixtureOdds(
        { ...state, snapshots: { [id]: accessorRecord } },
        base(),
      ),
    ).toThrow(FixtureOddsStateCorruptionError);
    expect(getterReads).toBe(0);

    const undefinedOptional = {
      ...state.snapshots[id]!,
      selectionLabel: undefined,
    };
    expect(() =>
      transitionFixtureOdds(
        {
          ...state,
          snapshots: {
            [id]: undefinedOptional as unknown as (typeof state.snapshots)[string],
          },
        },
        base(),
      ),
    ).toThrow(FixtureOddsStateCorruptionError);
  });

  it("never reads inherited optional-label pollution", () => {
    const unlabeled = { ...base() };
    delete unlabeled.selectionLabel;
    delete unlabeled.sportsbookLabel;
    const state = transitionFixtureOdds(undefined, unlabeled).state;
    const id = state.currentSnapshotId;
    let inheritedReads = 0;
    const prototype = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(prototype, "selectionLabel", {
      enumerable: true,
      get: () => {
        inheritedReads += 1;
        return "polluted";
      },
    });
    const polluted = Object.assign(
      Object.create(prototype) as Record<string, unknown>,
      state.snapshots[id],
    ) as unknown as (typeof state.snapshots)[string];
    expect(() =>
      transitionFixtureOdds(
        { ...state, snapshots: { [id]: polluted } },
        unlabeled,
      ),
    ).toThrow(FixtureOddsStateCorruptionError);
    expect(inheritedReads).toBe(0);
  });

  it("deep-clones retained caller data before returning", () => {
    const normalized = normalizeFixtureOddsObservation(base());
    const mutable = {
      partition: {
        canonicalEventId: normalized.canonicalEventId,
        canonicalEventVersion: normalized.canonicalEventVersion,
        sportKey: normalized.sportKey,
        marketKey: normalized.marketKey,
        selectionKey: normalized.selectionKey,
        sportsbookId: normalized.sportsbookId,
        key: normalized.partitionKey,
      },
      snapshots: { [normalized.snapshotId]: { ...normalized } },
      currentSnapshotId: normalized.snapshotId,
    } satisfies FixtureOddsState;
    const result = transitionFixtureOdds(mutable, base());
    mutable.snapshots[normalized.snapshotId]!.selectionLabel = "mutated";
    expect(result.state.snapshots[normalized.snapshotId]!.selectionLabel).toBe(
      "New York",
    );
  });

  it("is deterministic across repeated executions", () => {
    const runs = Array.from({ length: 20 }, () =>
      transitionFixtureOdds(undefined, base()),
    );
    expect(
      runs.every(
        (run) =>
          run.state.currentSnapshotId === runs[0]!.state.currentSnapshotId,
      ),
    ).toBe(true);
  });
});
