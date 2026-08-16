import { TRACK_PROFILE_VERSION, type TrackProfile } from '@/services/automix/trackProfile';

// test/unit/automix/trackProfileFixture.ts
// One offline profile to override fields on, shared so that adding a field to TrackProfile does
// not mean editing the same sixteen-line literal in three test files.

export const makeProfile = (overrides: Partial<TrackProfile> = {}): TrackProfile => ({
    version: TRACK_PROFILE_VERSION,
    partial: false,
    duration: 200,
    leadIn: 0,
    vocalStart: null,
    leadOut: 0,
    startsHot: false,
    endsHot: false,
    introSlope: 0,
    outroSlope: 0,
    loudness: -14,
    bpm: 120,
    beatOffset: 0,
    key: -1,
    major: true,
    keyConfidence: 0,
    ...overrides,
});
