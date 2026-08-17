import { beforeEach, describe, expect, it, vi } from 'vitest';

const cachedAudioMock = vi.hoisted(() => vi.fn());
const songCacheMock = vi.hoisted(() => vi.fn());
const sourceMock = vi.hoisted(() => vi.fn());
const lyricsMock = vi.hoisted(() => vi.fn());
const autoMatchMock = vi.hoisted(() => vi.fn());
const loadLyricsStateMock = vi.hoisted(() => vi.fn());
const saveLyricsStateMock = vi.hoisted(() => vi.fn());
const isUrlValidMock = vi.hoisted(() => vi.fn(() => true));
const updatePrefetchedAudioUrlMock = vi.hoisted(() => vi.fn());

vi.mock('@/services/onlineMusic/resourceCache', () => ({
    getCachedSongAudioBlob: cachedAudioMock,
    getSongCacheWithLegacyMigration: songCacheMock,
}));

vi.mock('@/services/onlineMusic/omni', () => ({
    omni: {
        getAudioSource: sourceMock,
        getLyrics: lyricsMock,
    },
}));

vi.mock('@/stores/useSettingsUiStore', () => ({
    useSettingsUiStore: {
        getState: () => ({ autoUseBestLyric: true, preferredAlternativeLyricSource: 'qq' }),
    },
}));

vi.mock('@/utils/lyrics/autoMatchBestLyric', () => ({
    autoMatchBestLyric: autoMatchMock,
}));

vi.mock('@/utils/onlineLyricsState', () => ({
    loadOnlineLyricsState: loadLyricsStateMock,
    resolveOnlineLyrics: (_state: unknown, lyrics: unknown) => lyrics,
    saveOnlineLyricsState: saveLyricsStateMock,
}));

vi.mock('@/services/prefetchService', () => ({
    isUrlValid: isUrlValidMock,
    updatePrefetchedAudioUrl: updatePrefetchedAudioUrlMock,
}));

vi.mock('@/services/db', () => ({
    saveToCache: vi.fn(),
}));

vi.mock('@/utils/blobGuards', () => ({
    createSafeObjectUrl: vi.fn(() => 'blob:test'),
}));

import { loadOnlineSongAudioSource, loadOnlineSongLyrics } from '@/services/onlinePlayback';
import type { SongResult } from '@/types';

// test/unit/onlinePlayback.test.ts

const song: SongResult = {
    id: 'online-song',
    name: 'Song',
    artists: [],
    album: { id: 'album', name: 'Album' },
    durationMs: 1000,
    sourceRef: { kind: 'online', providerId: 'kugou', mediaId: 'online-song' },
};

describe('online audio ReplayGain plumbing', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        cachedAudioMock.mockResolvedValue(null);
        isUrlValidMock.mockReturnValue(true);
    });

    it('returns provider metadata and stores it with the prefetched URL', async () => {
        sourceMock.mockResolvedValue({
            url: 'https://audio.test/song.flac',
            fetchedAt: 1,
            quality: 'high',
            replayGain: { trackGain: -12.1, trackPeak: 0.95 },
        });

        const result = await loadOnlineSongAudioSource(song, 'high', null);

        expect(result).toMatchObject({
            kind: 'ok',
            audioSrc: 'https://audio.test/song.flac',
            replayGain: { trackGain: -12.1, trackPeak: 0.95 },
        });
        expect(updatePrefetchedAudioUrlMock).toHaveBeenCalledWith(
            song,
            'https://audio.test/song.flac',
            'high',
            { trackGain: -12.1, trackPeak: 0.95 },
        );
    });

    it('reuses prefetched metadata without asking the provider again', async () => {
        const prefetched = {
            audioUrl: 'https://audio.test/prefetched.flac',
            audioUrlFetchedAt: Date.now(),
            replayGain: { trackGain: -3.2 },
        } as any;

        const result = await loadOnlineSongAudioSource(song, 'high', prefetched);

        expect(result).toMatchObject({
            kind: 'ok',
            audioSrc: 'https://audio.test/prefetched.flac',
            replayGain: { trackGain: -3.2 },
        });
        expect(sourceMock).not.toHaveBeenCalled();
    });

    it('leaves ReplayGain absent when the provider has no metadata', async () => {
        sourceMock.mockResolvedValue({
            url: 'https://audio.test/song.mp3',
            fetchedAt: 1,
            quality: 'high',
        });

        const result = await loadOnlineSongAudioSource(song, 'high', null);

        expect(result).toMatchObject({ kind: 'ok', audioSrc: 'https://audio.test/song.mp3' });
        expect(result.kind).toBe('ok');
        if (result.kind === 'ok') {
            expect(result.replayGain).toBeUndefined();
        }
        expect(updatePrefetchedAudioUrlMock).toHaveBeenCalledWith(song, 'https://audio.test/song.mp3', 'high', undefined);
    });
});

describe('online QQ lyric candidate plumbing', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        songCacheMock.mockResolvedValue(null);
        loadLyricsStateMock.mockResolvedValue(null);
    });

    it('passes the already-loaded QQ song and lyrics to auto-match as its provider candidate', async () => {
        const qqSong: SongResult = {
            ...song,
            id: 201,
            qqMid: 'qq-mid',
            sourceRef: { kind: 'online', providerId: 'qq', mediaId: 'qq-mid' },
        };
        const lyrics = {
            lines: [{ startTime: 0, endTime: 1, fullText: 'line', words: [] }],
            isWordByWord: true,
        };
        lyricsMock.mockResolvedValue({
            lyrics,
            mainText: '[00:00.00]line',
            wordByWordText: '[0,1000](0,1000,0)line',
            translationText: null,
            isPureMusic: false,
            chorusRanges: [],
        });
        autoMatchMock.mockResolvedValue({
            lyrics,
            source: 'qq',
            id: 201,
            qqMid: 'qq-mid',
            song: qqSong,
        });

        await loadOnlineSongLyrics(qqSong, null, null, {
            isCurrent: () => true,
            onLyrics: vi.fn(),
            onDone: vi.fn(),
        });

        expect(autoMatchMock).toHaveBeenCalledWith('Song', '', 1000, expect.objectContaining({
            preferredSource: 'qq',
            providerCandidate: expect.objectContaining({
                providerId: 'qq',
                song: qqSong,
                lyricsResult: expect.objectContaining({ lyrics, isPureMusic: false }),
            }),
        }));
        expect(saveLyricsStateMock).not.toHaveBeenCalled();
    });

    it('reports done before the auto-match search finishes, so audio never waits on it', async () => {
        // onDone is what releases playback. Auto-match asks every provider for a BETTER lyric file
        // and takes seconds when it finds none - an instrumental interlude matches nothing
        // anywhere. Holding the audio for an optional upgrade turned every such song change into
        // seconds of silence, and with a blended change the outgoing track has already ended by
        // then, so silence is all that is left.
        const lyrics = {
            lines: [{ startTime: 0, endTime: 1, fullText: 'line', words: [] }],
            isWordByWord: false,
        };
        lyricsMock.mockResolvedValue({
            lyrics,
            mainText: '[00:00.00]line',
            wordByWordText: null,
            translationText: null,
            isPureMusic: false,
            chorusRanges: [],
        });

        let finishAutoMatch = () => { };
        autoMatchMock.mockReturnValue(new Promise(resolve => {
            finishAutoMatch = () => resolve(null);
        }));

        const onDone = vi.fn();
        const onLyrics = vi.fn();
        const pending = loadOnlineSongLyrics(song, null, null, {
            isCurrent: () => true,
            onLyrics,
            onDone,
        });

        await vi.waitFor(() => expect(autoMatchMock).toHaveBeenCalled());

        // Still inside the search, and playback has already been let go.
        expect(onDone).toHaveBeenCalled();
        expect(onLyrics).toHaveBeenCalledWith(lyrics);

        finishAutoMatch();
        await pending;
    });
});
