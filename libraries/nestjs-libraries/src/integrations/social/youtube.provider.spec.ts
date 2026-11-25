import { Readable } from 'stream';
import { YoutubeProvider } from './youtube.provider';
import { PublishedWithError, RefreshToken } from '../social.abstract';

jest.mock(
  'googleapis',
  () => ({
    google: {
      auth: { OAuth2: jest.fn(() => ({ setCredentials: jest.fn() })) },
      youtube: jest.fn(() => ({ thumbnails: { set: mockSet } })),
    },
  }),
  { virtual: true }
);
jest.mock('@prisma/client', () => ({}), { virtual: true });
jest.mock('sharp', () => ({}), { virtual: true });
jest.mock(
  '@temporalio/activity',
  () => ({
    ApplicationFailure: class extends Error {
      constructor(
        message: string,
        public type: string,
        _retry: boolean,
        public details: any[]
      ) {
        super(message);
      }
    },
  }),
  { virtual: true }
);
jest.mock(
  '@gitroom/nestjs-libraries/dtos/posts/providers-settings/youtube.settings.dto',
  () => ({ YoutubeSettingsDto: class {} })
);
jest.mock(
  '@gitroom/nestjs-libraries/dtos/webhooks/ssrf.safe.dispatcher',
  () => ({})
);
jest.mock('@gitroom/nestjs-libraries/temporal/temporal.heartbeat', () => ({
  setHeartbeatDetails: jest.fn(),
}));
jest.mock('@gitroom/nestjs-libraries/chat/rules.description.decorator', () => ({
  Rules: () => () => undefined,
}));
jest.mock(
  '@gitroom/nestjs-libraries/integrations/dashboard.function.decorator',
  () => ({ DashboardFunction: () => () => undefined })
);

const mockSet = jest.fn();
const youtubeError = (reason = 'forbidden', status = 403) => ({
  response: {
    status,
    data: {
      error: {
        code: status,
        message: 'Thumbnail rejected',
        errors: [
          {
            reason,
            domain: 'youtube.thumbnail',
            message: 'Thumbnail rejected',
          },
        ],
      },
    },
    headers: { authorization: 'SECRET_HEADER' },
  },
  config: { token: 'SECRET_CONFIG' },
});

describe('YouTube thumbnail errors', () => {
  const provider = new YoutubeProvider();

  it.each(['forbidden', 'videoNotReady'])(
    'preserves only allowed raw fields for %s',
    (reason) => {
      const message = provider.handleErrors(
        JSON.stringify(youtubeError(reason))
      )?.value;
      for (const field of [
        '403',
        reason,
        'youtube.thumbnail',
        'Thumbnail rejected',
      ])
        expect(message).toContain(field);
      expect(message?.includes('phone-verified')).toBe(reason === 'forbidden');
      expect(message).not.toContain('SECRET');
    }
  );

  it.each([
    'imageTooTall',
    'imageTooWide',
    'imageFormatUnsupported',
    'failedPrecondition',
  ])('keeps specific %s advice and raw reason', (reason) => {
    const message = provider.handleErrors(
      JSON.stringify(youtubeError(reason))
    )?.value;
    expect(message).toContain(reason);
    expect(message).toContain('Thumbnail rejected');
  });

  it('accepts direct API bodies and incomplete or malformed input', () => {
    expect(
      provider.handleErrors(JSON.stringify(youtubeError().response.data))?.value
    ).toContain('403 forbidden');
    for (const body of [
      'youtube.thumbnail',
      '{youtube.thumbnail',
      '{}',
      'null',
    ])
      expect(() => provider.handleErrors(body)).not.toThrow();
    expect(provider.handleErrors('youtube.thumbnail')?.value).not.toContain(
      'phone-verified'
    );
  });

  it('accepts serialized response data and SDK top-level errors', () => {
    const error = youtubeError();
    expect(
      provider.handleErrors(
        JSON.stringify({
          response: { status: 403, data: JSON.stringify(error.response.data) },
        })
      )?.value
    ).toContain('403 forbidden / youtube.thumbnail: Thumbnail rejected');
    expect(
      provider.handleErrors(
        JSON.stringify({ code: 403, errors: error.response.data.error.errors })
      )?.value
    ).toContain('403 forbidden / youtube.thumbnail: Thumbnail rejected');
    expect(
      provider.handleErrors(
        JSON.stringify({ error: { errors: [{ domain: 'youtube.thumbnail' }] } })
      )?.value
    ).toBe(
      'Video uploaded, thumbnail could not be set. (YouTube: youtube.thumbnail)'
    );
  });

  it('routes thumbnail authentication failures to refresh', () => {
    expect(
      provider.handleErrors(
        JSON.stringify(youtubeError('UNAUTHENTICATED', 401))
      )?.type
    ).toBe('refresh-token');
  });
});

describe('YouTube thumbnail retry after upload', () => {
  let provider: YoutubeProvider;
  let source: jest.Mock;
  const pending = {
    videoId: 'video-123',
    thumbnail: 'https://example.test/image.jpg',
    postDbId: 'post-123',
  };

  beforeEach(() => {
    jest.useFakeTimers();
    mockSet.mockReset();
    provider = new YoutubeProvider();
    source = jest
      .fn()
      .mockImplementation(async () => ({ data: Readable.from(['image']) }));
    jest.spyOn(provider, 'getSsrfSafeAxios').mockReturnValue(source as any);
  });
  afterEach(() => jest.useRealTimers());

  it('re-fetches the stream after 30 seconds and completes without re-uploading', async () => {
    mockSet
      .mockRejectedValueOnce(youtubeError('videoNotReady'))
      .mockResolvedValueOnce({});
    const result = provider.finalizePost('token', pending as any, {} as any);
    const completed = expect(result).resolves.toEqual({
      status: 'completed',
      postId: 'video-123',
      releaseURL: 'https://www.youtube.com/watch?v=video-123',
    });
    await jest.advanceTimersByTimeAsync(29_999);
    expect(mockSet).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    await completed;
    expect(source).toHaveBeenCalledTimes(2);
    expect(mockSet).toHaveBeenCalledTimes(2);
    expect(mockSet.mock.calls[0][0].media.body).not.toBe(
      mockSet.mock.calls[1][0].media.body
    );
  });

  it('also retries thumbnails reached through the legacy blocking post path', async () => {
    jest
      .spyOn(provider, 'postPending')
      .mockResolvedValue([
        { id: 'post-123', status: 'pending', pendingData: pending },
      ] as any);
    mockSet
      .mockRejectedValueOnce(youtubeError('videoNotReady'))
      .mockResolvedValueOnce({});
    const result = provider.post('id', 'token', [] as any, {} as any);
    await jest.advanceTimersByTimeAsync(30_000);
    await expect(result).resolves.toEqual([
      {
        id: 'post-123',
        status: 'success',
        postId: 'video-123',
        releaseURL: 'https://www.youtube.com/watch?v=video-123',
      },
    ]);
    expect(source).toHaveBeenCalledTimes(2);
  });

  it('preserves video ID and URL if both attempts fail', async () => {
    mockSet.mockRejectedValue(youtubeError());
    const failure = provider
      .finalizePost('token', pending as any, {} as any)
      .catch((err) => err);
    await jest.advanceTimersByTimeAsync(30_000);
    const err = await failure;
    expect(err).toBeInstanceOf(PublishedWithError);
    expect(err).toMatchObject({
      releaseId: 'video-123',
      releaseURL: 'https://www.youtube.com/watch?v=video-123',
      postDbId: 'post-123',
    });
    expect(err.message).toContain('403 forbidden');
    expect(mockSet).toHaveBeenCalledTimes(2);
  });

  it('does not retry locally on a refresh-token error', async () => {
    mockSet.mockRejectedValue(youtubeError('UNAUTHENTICATED', 401));
    const failure = provider
      .finalizePost('token', pending as any, {} as any)
      .catch((err) => err);
    await jest.advanceTimersByTimeAsync(30_000);
    expect(await failure).toBeInstanceOf(RefreshToken);
    expect(mockSet).toHaveBeenCalledTimes(1);
    expect(source).toHaveBeenCalledTimes(1);
  });
});
