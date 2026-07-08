import { describe, it, expect } from 'vitest';
import {
  PROFILE_KNOBS,
  diffProfileKnobs,
  decideProfileTransition,
  decideProfileChangeFlow,
  tallyProfileTransitions,
  formatProfileTransitionNotice,
  type ProfileTransitionPlan,
} from '../graphicsProfileTransitionHelpers';

describe('PROFILE_KNOBS', () => {
  it('has an entry for each of the 4 ParseProfile values', () => {
    expect(Object.keys(PROFILE_KNOBS).sort()).toEqual([
      'balanced',
      'performance',
      'quality',
      'ultra_fast',
    ]);
  });

  it('encodes CIRCLE_SEGMENTS in descending order quality → ultra_fast', () => {
    expect(PROFILE_KNOBS.quality.circleSegments).toBe(24);
    expect(PROFILE_KNOBS.balanced.circleSegments).toBe(18);
    expect(PROFILE_KNOBS.performance.circleSegments).toBe(14);
    expect(PROFILE_KNOBS.ultra_fast.circleSegments).toBe(6);
  });

  it('quality keeps non-visual categories; balanced/perf/ultra drop them', () => {
    expect(PROFILE_KNOBS.quality.dropsNonVisualCategories).toBe(false);
    expect(PROFILE_KNOBS.balanced.dropsNonVisualCategories).toBe(true);
    expect(PROFILE_KNOBS.performance.dropsNonVisualCategories).toBe(true);
    expect(PROFILE_KNOBS.ultra_fast.dropsNonVisualCategories).toBe(true);
  });

  it('only performance + ultra_fast drop property classes', () => {
    expect(PROFILE_KNOBS.quality.dropsPropertyClasses).toBe(false);
    expect(PROFILE_KNOBS.balanced.dropsPropertyClasses).toBe(false);
    expect(PROFILE_KNOBS.performance.dropsPropertyClasses).toBe(true);
    expect(PROFILE_KNOBS.ultra_fast.dropsPropertyClasses).toBe(true);
  });

  it('only ultra_fast drops MEP + furnishing geometry', () => {
    expect(PROFILE_KNOBS.quality.dropsMepAndFurnishing).toBe(false);
    expect(PROFILE_KNOBS.balanced.dropsMepAndFurnishing).toBe(false);
    expect(PROFILE_KNOBS.performance.dropsMepAndFurnishing).toBe(false);
    expect(PROFILE_KNOBS.ultra_fast.dropsMepAndFurnishing).toBe(true);
  });

  it('geometry-threshold variant differs only on performance + ultra_fast', () => {
    expect(PROFILE_KNOBS.quality.geometryThresholds).toBe('default');
    expect(PROFILE_KNOBS.balanced.geometryThresholds).toBe('default');
    expect(PROFILE_KNOBS.performance.geometryThresholds).toBe('performance');
    expect(PROFILE_KNOBS.ultra_fast.geometryThresholds).toBe('ultra_fast');
  });

  it('memory-limit override is null for quality + balanced', () => {
    expect(PROFILE_KNOBS.quality.memoryLimitMb).toBeNull();
    expect(PROFILE_KNOBS.balanced.memoryLimitMb).toBeNull();
    expect(PROFILE_KNOBS.performance.memoryLimitMb).toBe(384);
    expect(PROFILE_KNOBS.ultra_fast.memoryLimitMb).toBe(1024);
  });
});

describe('diffProfileKnobs', () => {
  it('returns [] for identical profiles (all 4 self-comparisons)', () => {
    expect(diffProfileKnobs('quality', 'quality')).toEqual([]);
    expect(diffProfileKnobs('balanced', 'balanced')).toEqual([]);
    expect(diffProfileKnobs('performance', 'performance')).toEqual([]);
    expect(diffProfileKnobs('ultra_fast', 'ultra_fast')).toEqual([]);
  });

  it('balanced → quality: circle-segments + non-visual drop', () => {
    expect(diffProfileKnobs('balanced', 'quality')).toEqual([
      'circle-segments',
      'drops-non-visual-categories',
    ]);
  });

  it('balanced → performance: 4 knobs flip simultaneously', () => {
    expect(diffProfileKnobs('balanced', 'performance')).toEqual([
      'circle-segments',
      'drops-property-classes',
      'geometry-thresholds',
      'memory-limit',
    ]);
  });

  it('quality → performance: every knob in the vocabulary except MEP differs', () => {
    expect(diffProfileKnobs('quality', 'performance')).toEqual([
      'circle-segments',
      'drops-non-visual-categories',
      'drops-property-classes',
      'geometry-thresholds',
      'memory-limit',
    ]);
  });

  it('performance → ultra_fast: only categories + thresholds + memory cap differ', () => {
    expect(diffProfileKnobs('performance', 'ultra_fast')).toEqual([
      'circle-segments',
      'drops-mep-and-furnishing',
      'geometry-thresholds',
      'memory-limit',
    ]);
  });

  it('is symmetric under argument swap (label set matches; order matches)', () => {
    expect(diffProfileKnobs('balanced', 'performance')).toEqual(
      diffProfileKnobs('performance', 'balanced'),
    );
    expect(diffProfileKnobs('quality', 'ultra_fast')).toEqual(
      diffProfileKnobs('ultra_fast', 'quality'),
    );
  });

  it('returns labels in the declared deterministic order, not insertion order', () => {
    const diff = diffProfileKnobs('quality', 'performance');
    expect(diff[0]).toBe('circle-segments');
    expect(diff[diff.length - 1]).toBe('memory-limit');
  });
});

describe('decideProfileTransition', () => {
  it('returns noop for same-profile, modelLoaded does not matter', () => {
    expect(
      decideProfileTransition({ prev: 'balanced', next: 'balanced', modelLoaded: true }),
    ).toEqual({ kind: 'noop', reason: 'same-profile', changedKnobs: [] });
    expect(
      decideProfileTransition({ prev: 'balanced', next: 'balanced', modelLoaded: false }),
    ).toEqual({ kind: 'noop', reason: 'same-profile', changedKnobs: [] });
  });

  it('returns noop-no-model when the user flips before loading a model', () => {
    const plan = decideProfileTransition({
      prev: 'balanced',
      next: 'performance',
      modelLoaded: false,
    });
    expect(plan.kind).toBe('noop-no-model');
    expect(plan.reason).toBe('no-model-loaded-pref-only');
    expect(plan.changedKnobs.length).toBeGreaterThan(0);
  });

  it('returns reload-required for every cross-profile change with a model loaded', () => {
    const profiles = ['quality', 'balanced', 'performance', 'ultra_fast'] as const;
    for (const a of profiles) {
      for (const b of profiles) {
        if (a === b) continue;
        const plan = decideProfileTransition({ prev: a, next: b, modelLoaded: true });
        expect(plan.kind).toBe('reload-required');
        expect(plan.reason).toBe('parse-time-knobs-differ');
        expect(plan.changedKnobs.length).toBeGreaterThan(0);
      }
    }
  });

  it('reload plan surfaces the same knob list diffProfileKnobs returns', () => {
    const plan = decideProfileTransition({
      prev: 'balanced',
      next: 'quality',
      modelLoaded: true,
    });
    expect(plan.changedKnobs).toEqual(diffProfileKnobs('balanced', 'quality'));
  });

  it('noop-no-model still reports changedKnobs so the next load can log the diff', () => {
    const plan = decideProfileTransition({
      prev: 'balanced',
      next: 'performance',
      modelLoaded: false,
    });
    expect(plan.changedKnobs).toEqual(diffProfileKnobs('balanced', 'performance'));
  });

  it('tweak-in-place is currently unreachable - no two profiles differ only on in-place knobs (today)', () => {
    // This is a regression-pin: if a future profile redesign introduces an
    // in-place-only knob (LOD / edge / shadow), this assertion is expected
    // to flip and should be updated alongside the wire-up.
    const profiles = ['quality', 'balanced', 'performance', 'ultra_fast'] as const;
    const kinds = new Set<string>();
    for (const a of profiles) {
      for (const b of profiles) {
        if (a === b) continue;
        kinds.add(
          decideProfileTransition({ prev: a, next: b, modelLoaded: true }).kind,
        );
      }
    }
    expect(kinds.has('tweak-in-place')).toBe(false);
    expect(kinds.has('reload-required')).toBe(true);
  });
});

describe('tallyProfileTransitions', () => {
  it('empty stream counts to zero across the board', () => {
    expect(tallyProfileTransitions([])).toEqual({
      noop: 0,
      noopNoModel: 0,
      tweakInPlace: 0,
      reloadRequired: 0,
      total: 0,
    });
  });

  it('counts each kind independently', () => {
    const stream: ProfileTransitionPlan[] = [
      decideProfileTransition({ prev: 'balanced', next: 'balanced', modelLoaded: true }),
      decideProfileTransition({ prev: 'balanced', next: 'performance', modelLoaded: false }),
      decideProfileTransition({ prev: 'balanced', next: 'performance', modelLoaded: true }),
      decideProfileTransition({ prev: 'quality', next: 'balanced', modelLoaded: true }),
    ];
    const tally = tallyProfileTransitions(stream);
    expect(tally).toEqual({
      noop: 1,
      noopNoModel: 1,
      tweakInPlace: 0,
      reloadRequired: 2,
      total: 4,
    });
  });

  it('total always equals the stream length', () => {
    const stream: ProfileTransitionPlan[] = [];
    for (let i = 0; i < 17; i += 1) {
      stream.push(
        decideProfileTransition({
          prev: 'balanced',
          next: 'performance',
          modelLoaded: i % 2 === 0,
        }),
      );
    }
    expect(tallyProfileTransitions(stream).total).toBe(17);
  });
});

describe('formatProfileTransitionNotice', () => {
  it('returns null notice for noop (prev === next)', () => {
    const plan = decideProfileTransition({
      prev: 'balanced',
      next: 'balanced',
      modelLoaded: true,
    });
    expect(formatProfileTransitionNotice(plan, 'balanced')).toEqual({
      kind: null,
      message: null,
    });
  });

  it('returns null notice for noop-no-model (silent pref save)', () => {
    const plan = decideProfileTransition({
      prev: 'balanced',
      next: 'performance',
      modelLoaded: false,
    });
    expect(formatProfileTransitionNotice(plan, 'performance')).toEqual({
      kind: null,
      message: null,
    });
  });

  it('returns reload-required notice naming the next profile + changed knobs', () => {
    const plan = decideProfileTransition({
      prev: 'balanced',
      next: 'performance',
      modelLoaded: true,
    });
    const notice = formatProfileTransitionNotice(plan, 'performance');
    expect(notice.kind).toBe('info');
    expect(notice.message).toContain('Re-load');
    expect(notice.message).toContain('performance');
    // each parse-time knob from the plan must surface in the message body
    for (const knob of plan.changedKnobs) {
      expect(notice.message).toContain(knob);
    }
  });

  it('reload-required message quotes the next profile (not the prev)', () => {
    const plan = decideProfileTransition({
      prev: 'performance',
      next: 'quality',
      modelLoaded: true,
    });
    const notice = formatProfileTransitionNotice(plan, 'quality');
    expect(notice.message).toContain('quality');
    // We don't say "performance" in the body - we tell the user where to
    // go, not where they came from.
    expect(notice.message).not.toContain(' performance ');
  });

  it('tweak-in-place notice fires "applied" copy (regression pin - unreachable today)', () => {
    // Hand-construct a tweak-in-place plan so we can pin the message
    // shape without waiting for a real renderer-side knob to land.
    const plan: ProfileTransitionPlan = {
      kind: 'tweak-in-place',
      reason: 'only-in-place-knobs-differ',
      changedKnobs: [],
    };
    const notice = formatProfileTransitionNotice(plan, 'performance');
    expect(notice.kind).toBe('info');
    expect(notice.message).toContain('applied');
    expect(notice.message).toContain('performance');
  });

  it('toast kind never escalates past info (settings change is not an error)', () => {
    const profiles = ['quality', 'balanced', 'performance', 'ultra_fast'] as const;
    for (const a of profiles) {
      for (const b of profiles) {
        for (const modelLoaded of [true, false] as const) {
          const plan = decideProfileTransition({ prev: a, next: b, modelLoaded });
          const notice = formatProfileTransitionNotice(plan, b);
          // Allowed values: 'info' or null. Nothing else.
          expect(notice.kind === 'info' || notice.kind === null).toBe(true);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// decideProfileChangeFlow
// ---------------------------------------------------------------------------

describe('decideProfileChangeFlow', () => {
  it('returns silent for noop plans', () => {
    const noop: ProfileTransitionPlan = {
      kind: 'noop',
      reason: 'same-profile',
      changedKnobs: [],
    };
    const d = decideProfileChangeFlow(noop, 'balanced');
    expect(d.flow).toBe('silent');
    expect(d.confirmTitle).toBeNull();
    expect(d.confirmBody).toBeNull();
  });

  it('returns silent for noop-no-model plans (no model to reload)', () => {
    const plan: ProfileTransitionPlan = {
      kind: 'noop-no-model',
      reason: 'no-model-loaded-pref-only',
      changedKnobs: ['circle-segments'],
    };
    const d = decideProfileChangeFlow(plan, 'performance');
    expect(d.flow).toBe('silent');
  });

  it('returns immediate for tweak-in-place plans (reserved future case)', () => {
    const plan: ProfileTransitionPlan = {
      kind: 'tweak-in-place',
      reason: 'only-in-place-knobs-differ',
      changedKnobs: [],
    };
    const d = decideProfileChangeFlow(plan, 'quality');
    expect(d.flow).toBe('immediate');
    expect(d.confirmTitle).toBeNull();
  });

  it('returns confirm for reload-required plans with title + body', () => {
    const plan: ProfileTransitionPlan = {
      kind: 'reload-required',
      reason: 'parse-time-knobs-differ',
      changedKnobs: ['circle-segments', 'memory-limit'],
    };
    const d = decideProfileChangeFlow(plan, 'performance');
    expect(d.flow).toBe('confirm');
    expect(d.confirmTitle).toContain('performance');
    expect(d.confirmBody).toContain('circle-segments');
    expect(d.confirmBody).toContain('memory-limit');
    expect(d.confirmBody).toMatch(/re-drop/i);
    expect(d.confirmBody).toContain('IFC');
  });

  it('confirm title quotes the next profile name for clarity', () => {
    const plan: ProfileTransitionPlan = {
      kind: 'reload-required',
      reason: 'parse-time-knobs-differ',
      changedKnobs: ['circle-segments'],
    };
    const d = decideProfileChangeFlow(plan, 'quality');
    // Title contains the next profile so users see what they're switching to.
    expect(d.confirmTitle).toMatch(/quality/);
  });

  it('confirm body explains the cancel branch (so users know they can back out)', () => {
    const plan: ProfileTransitionPlan = {
      kind: 'reload-required',
      reason: 'parse-time-knobs-differ',
      changedKnobs: ['drops-mep-and-furnishing'],
    };
    const d = decideProfileChangeFlow(plan, 'ultra_fast');
    // The cancel-branch explanation is mandatory - without it users worry
    // about losing state when they click Cancel.
    expect(d.confirmBody).toContain('Cancel');
  });

  it('every (a → b) pair against modelLoaded=true → flow is one of three values', () => {
    const profiles = ['quality', 'balanced', 'performance', 'ultra_fast'] as const;
    const allowed = new Set(['silent', 'immediate', 'confirm']);
    for (const a of profiles) {
      for (const b of profiles) {
        const plan = decideProfileTransition({ prev: a, next: b, modelLoaded: true });
        const d = decideProfileChangeFlow(plan, b);
        expect(allowed.has(d.flow)).toBe(true);
      }
    }
  });
});
