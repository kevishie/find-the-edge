import { describe, expect, it } from "vitest";

import {
  FixtureOddsInputError,
  FixtureOddsStateCorruptionError,
  fixtureOddsGroupAvailabilityIdentity,
  normalizeFixtureOddsObservation,
  isFixtureOddsSnapshotActionable,
  readFixtureOddsSnapshotRecord,
  sha256Hex,
  transitionFixtureOdds,
  transitionFixtureOddsAvailability,
  type FixtureOddsObservation,
  type FixtureOddsState,
  type NormalizedFixtureOddsSnapshot,
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

/**
 * Independent restatement of the frozen legacy (v1) identity: the pre-change
 * encoding that hashed our fetch clock into snapshot identity. Kept literal so
 * a regression in the production legacy path cannot hide behind a shared helper.
 */
const legacyIdentity = (observation: FixtureOddsObservation) => {
  const iso = (value: string) => new Date(Date.parse(value)).toISOString();
  const values: (string | number | null)[] = [
    observation.canonicalEventId,
    observation.canonicalEventVersion,
    observation.sportKey,
    observation.marketKey,
    observation.selectionKey,
    observation.selectionLabel ?? null,
    observation.sportsbookId,
    observation.sportsbookLabel ?? null,
    observation.americanOdds,
    iso(observation.observedAt),
    iso(observation.retrievedAt),
  ];
  if (observation.point !== undefined) values.push(observation.point);
  if (observation.provenance !== undefined)
    values.push(
      observation.provenance.providerId,
      observation.provenance.policyVersion,
      observation.provenance.bookRole,
      observation.provenance.sourceState,
    );
  const snapshotId = sha256Hex(JSON.stringify(values));
  return {
    snapshotId,
    sortKey: `SNAPSHOT#${iso(observation.observedAt)}#${snapshotId}`,
  };
};

const legacyRow = (
  observation: FixtureOddsObservation,
): NormalizedFixtureOddsSnapshot => ({
  ...normalizeFixtureOddsObservation(observation),
  ...legacyIdentity(observation),
});

const stateOf = (
  snapshot: NormalizedFixtureOddsSnapshot,
): FixtureOddsState => ({
  partition: {
    canonicalEventId: snapshot.canonicalEventId,
    canonicalEventVersion: snapshot.canonicalEventVersion,
    sportKey: snapshot.sportKey,
    marketKey: snapshot.marketKey,
    selectionKey: snapshot.selectionKey,
    sportsbookId: snapshot.sportsbookId,
    key: snapshot.partitionKey,
  },
  snapshots: { [snapshot.snapshotId]: snapshot },
  currentSnapshotId: snapshot.snapshotId,
});

describe("fixture odds snapshot identity", () => {
  it("identifies the observed market state, not our fetch clock", () => {
    const first = normalizeFixtureOddsObservation(
      base({ retrievedAt: "2026-08-01T12:00:01Z" }),
    );
    const twelveSecondsLater = normalizeFixtureOddsObservation(
      base({ retrievedAt: "2026-08-01T12:00:13Z" }),
    );
    expect(twelveSecondsLater.snapshotId).toBe(first.snapshotId);
    expect(twelveSecondsLater.sortKey).toBe(first.sortKey);
    expect(twelveSecondsLater.retrievedAt).toBe("2026-08-01T12:00:13.000Z");
    expect(first.retrievedAt).toBe("2026-08-01T12:00:01.000Z");
  });

  const identityOverrides: readonly [
    string,
    Partial<FixtureOddsObservation>,
  ][] = [
    ["price", { americanOdds: -111 }],
    ["point", { point: -1.5 }],
    ["provider observed time", { observedAt: "2026-08-01T12:00:01Z" }],
    ["selection label", { selectionLabel: "New York Mets" }],
    ["sportsbook label", { sportsbookLabel: "Other Book" }],
    ["canonical event", { canonicalEventId: "event:mlb:2" }],
    ["canonical version", { canonicalEventVersion: 8 }],
    ["sportsbook", { sportsbookId: "other-book" }],
    [
      "provenance",
      {
        provenance: {
          providerId: "sharpapi",
          policyVersion: "v1",
          bookRole: "offered",
          sourceState: "active",
        },
      },
    ],
  ];
  it.each(identityOverrides)(
    "changes identity when the %s changes",
    (_label, override) => {
      const baseline = normalizeFixtureOddsObservation(base());
      const changed = normalizeFixtureOddsObservation(base(override));
      expect(changed.snapshotId).not.toBe(baseline.snapshotId);
    },
  );

  it("changes identity for every provenance field", () => {
    const provenance = {
      providerId: "sharpapi",
      policyVersion: "v1",
      bookRole: "offered",
      sourceState: "active",
    } as const;
    const baseline = normalizeFixtureOddsObservation(base({ provenance }));
    for (const override of [
      { providerId: "the-odds-api" },
      { policyVersion: "v2" },
      { bookRole: "comparison" as const },
      { sourceState: "stale" as const },
    ])
      expect(
        normalizeFixtureOddsObservation(
          base({ provenance: { ...provenance, ...override } }),
        ).snapshotId,
      ).not.toBe(baseline.snapshotId);
  });

  it("authenticates a current-identity row and reports it as current", () => {
    const snapshot = normalizeFixtureOddsObservation(base());
    expect(readFixtureOddsSnapshotRecord(base(), snapshot)).toEqual({
      kind: "current",
      snapshot,
    });
  });

  it("still authenticates a legacy row hashed with retrievedAt", () => {
    for (const observation of [
      base(),
      base({ point: 2.5 }),
      base({
        provenance: {
          providerId: "sharpapi",
          policyVersion: "v1",
          bookRole: "offered",
          sourceState: "active",
        },
      }),
    ]) {
      const legacy = legacyIdentity(observation);
      expect(legacy.snapshotId).not.toBe(
        normalizeFixtureOddsObservation(observation).snapshotId,
      );
      const read = readFixtureOddsSnapshotRecord(observation, legacy);
      expect(read?.kind).toBe("legacy");
      expect(read?.snapshot.snapshotId).toBe(legacy.snapshotId);
      expect(read?.snapshot.sortKey).toBe(legacy.sortKey);
    }
  });

  it("rejects forged, half-matching, and cross-version identity claims", () => {
    const snapshot = normalizeFixtureOddsObservation(base());
    const legacy = legacyIdentity(base());
    const forgedContent = base({ americanOdds: -120 });
    expect(readFixtureOddsSnapshotRecord(forgedContent, snapshot)).toBeNull();
    expect(readFixtureOddsSnapshotRecord(forgedContent, legacy)).toBeNull();
    expect(
      readFixtureOddsSnapshotRecord(base(), {
        snapshotId: snapshot.snapshotId,
        sortKey: legacy.sortKey,
      }),
    ).toBeNull();
    expect(
      readFixtureOddsSnapshotRecord(base(), {
        snapshotId: legacy.snapshotId,
        sortKey: snapshot.sortKey,
      }),
    ).toBeNull();
    expect(
      readFixtureOddsSnapshotRecord(base(), {
        snapshotId: sha256Hex("forged"),
        sortKey: `SNAPSHOT#2026-08-01T12:00:00.000Z#${sha256Hex("forged")}`,
      }),
    ).toBeNull();
  });

  it("replays an unchanged re-observation without adding history", () => {
    const state = transitionFixtureOdds(undefined, base()).state;
    const replay = transitionFixtureOdds(
      state,
      base({ retrievedAt: "2026-08-01T12:00:13Z" }),
    );
    expect(replay.snapshot).toBe("existing");
    expect(replay.current).toBe("retained");
    expect(Object.keys(replay.state.snapshots)).toHaveLength(1);
    expect(
      replay.state.snapshots[replay.state.currentSnapshotId]!.retrievedAt,
    ).toBe("2026-08-01T12:00:01.000Z");
  });

  it("accepts a legacy stored row as prior state and never rewrites it", () => {
    const legacy = legacyRow(base());
    const result = transitionFixtureOdds(stateOf(legacy), base());
    expect(Object.keys(result.state.snapshots)).toHaveLength(2);
    expect(result.state.snapshots[legacy.snapshotId]).toEqual(legacy);
    expect(result.snapshot).toBe("created");
  });

  it("rejects a legacy row whose content no longer matches its identity", () => {
    const tampered = { ...legacyRow(base()), americanOdds: -120 };
    expect(() => transitionFixtureOdds(stateOf(tampered), base())).toThrow(
      FixtureOddsStateCorruptionError,
    );
  });
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

  it("blocks older current prices on newer unavailable evidence and resumes monotonically", () => {
    const snapshot = normalizeFixtureOddsObservation(base());
    const blocked = transitionFixtureOddsAvailability(undefined, {
      identity: snapshot.partitionKey,
      state: "suspended",
      observedAt: "2026-08-01T12:01:00Z",
      evidenceId: "gap-1",
      reason: "suspended",
    });
    expect(isFixtureOddsSnapshotActionable(snapshot, blocked)).toBe(false);
    expect(
      transitionFixtureOddsAvailability(blocked, {
        ...blocked,
        state: "active",
        observedAt: "2026-08-01T11:59:00Z",
        evidenceId: "old-active",
      }),
    ).toBe(blocked);
    const resumed = transitionFixtureOddsAvailability(blocked, {
      ...blocked,
      state: "active",
      observedAt: "2026-08-01T12:04:00Z",
      evidenceId: "active-2",
    });
    const current = normalizeFixtureOddsObservation(
      base({ observedAt: "2026-08-01T12:03:00Z" }),
    );
    expect(
      isFixtureOddsSnapshotActionable(current, resumed, {
        ...resumed,
        identity: fixtureOddsGroupAvailabilityIdentity(current),
      }),
    ).toBe(true);
  });
});
