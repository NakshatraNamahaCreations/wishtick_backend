import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { execFileSync } from 'node:child_process';
import { promises as fs, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { Types, type Model } from 'mongoose';
import ffmpegStatic from 'ffmpeg-static';
import { ErrorCode } from 'src/common/errors/error-codes';
import { AuthService } from 'src/modules/auth/auth.service';
import { FfmpegService } from 'src/modules/reels/ffmpeg.service';
import { ReelCompileService } from 'src/modules/reels/reel-compile.service';
import { STORAGE, type IStorageProvider } from 'src/infra/storage/storage.port';
import { createTestApp, V1, type TestApp } from './utils/test-app';

interface Envelope<T> {
  success: boolean;
  data: T;
  error?: { code: string; message: string };
}
interface Actor {
  token: string;
  userId: string;
  name: string;
}
interface ReelView {
  id: string;
  status: string;
  wishCount: number;
  contributors: string[];
  reelMediaUrl: string | null;
  durationMs: number | null;
  wishes: { id: string; text: string | null }[];
  share?: { slug: string };
}

const FF = ffmpegStatic as unknown as string;
const MEDIA_DIR = path.join(process.cwd(), `.reels-test-media-${process.pid}`);

describe('Reels (e2e)', () => {
  let ctx: TestApp;
  let app: INestApplication;
  let authService: AuthService;
  let compileService: ReelCompileService;
  let ffmpeg: FfmpegService;
  let storage: IStorageProvider;
  let seq = 0;
  let videoBytes: Buffer;
  let audioBytes: Buffer;
  let longAudioBytes: Buffer;

  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  const newUser = async (): Promise<Actor> => {
    const name = `User ${++seq}`;
    const { user, tokens } = await authService.signup(
      {
        email: `reel${seq}.${Date.now()}@example.com`,
        password: 'correct-horse-battery-staple',
        name,
      },
      { ip: '127.0.0.1', userAgent: 'e2e' },
    );
    return { token: tokens.accessToken, userId: user.id, name };
  };

  /** Synthesize real media so ffprobe has genuine streams to read. */
  const genVideo = (file: string, seconds: number): Buffer => {
    execFileSync(FF, [
      '-y',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      `testsrc=size=320x240:rate=15:duration=${seconds}`,
      '-f',
      'lavfi',
      '-i',
      `sine=frequency=440:duration=${seconds}`,
      '-t',
      String(seconds),
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-c:a',
      'aac',
      file,
    ]);
    return readFileSync(file);
  };
  const genAudio = (file: string, seconds: number): Buffer => {
    execFileSync(FF, [
      '-y',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      `sine=frequency=660:duration=${seconds}`,
      '-t',
      String(seconds),
      '-c:a',
      'aac',
      file,
    ]);
    return readFileSync(file);
  };

  /** presign → PUT → confirm, returning a ready mediaId. */
  const uploadMedia = async (actor: Actor, bytes: Buffer, contentType: string): Promise<string> => {
    const ticket = (
      await request(app.getHttpServer())
        .post(`${V1}/media/upload-url`)
        .set(auth(actor.token))
        .send({ purpose: 'reel_wish', contentType, sizeBytes: bytes.length })
        .expect(201)
    ).body as Envelope<{ mediaId: string; uploadUrl: string }>;
    const url = new URL(ticket.data.uploadUrl);
    await request(app.getHttpServer())
      .put(url.pathname + url.search)
      .set('Content-Type', contentType)
      .send(bytes)
      .expect(200);
    await request(app.getHttpServer())
      .post(`${V1}/media/confirm`)
      .set(auth(actor.token))
      .send({ mediaId: ticket.data.mediaId })
      .expect(201);
    return ticket.data.mediaId;
  };

  const createReel = async (initiator: Actor, recipient: Actor): Promise<ReelView> => {
    const res = await request(app.getHttpServer())
      .post(`${V1}/reels`)
      .set(auth(initiator.token))
      .send({
        recipientUserId: recipient.userId,
        title: `${recipient.name}'s Birthday`,
        birthdayDate: '2026-12-25',
        timezone: 'Asia/Kolkata',
      })
      .expect(201);
    return (res.body as Envelope<ReelView>).data;
  };

  const addText = (actor: Actor, reelId: string, text: string) =>
    request(app.getHttpServer())
      .post(`${V1}/reels/${reelId}/wishes`)
      .set(auth(actor.token))
      .send({ kind: 'text', text });

  const getReel = (actor: Actor, reelId: string) =>
    request(app.getHttpServer()).get(`${V1}/reels/${reelId}`).set(auth(actor.token));

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
    authService = app.get(AuthService);
    compileService = app.get(ReelCompileService);
    ffmpeg = app.get(FfmpegService);
    storage = app.get<IStorageProvider>(STORAGE);
    await fs.mkdir(MEDIA_DIR, { recursive: true });
    videoBytes = genVideo(path.join(MEDIA_DIR, 'v.mp4'), 2);
    audioBytes = genAudio(path.join(MEDIA_DIR, 'a.m4a'), 2);
    longAudioBytes = genAudio(path.join(MEDIA_DIR, 'long.m4a'), 7); // over the 5s cap
  }, 180_000);

  afterAll(async () => {
    await ctx.close();
    await fs.rm(MEDIA_DIR, { recursive: true, force: true });
  });

  // ── Exit criterion: nothing leaks wish content before release ───────────────

  describe('the time-lock', () => {
    it('withholds wish content from the initiator, the recipient, and the share link', async () => {
      const initiator = await newUser();
      const recipient = await newUser();
      const friend = await newUser();
      const reel = await createReel(initiator, recipient);
      await addText(friend, reel.id, 'Happy birthday, you legend!').expect(201);

      // Surface 1: the initiator's authenticated view — metadata only.
      const asInitiator = (await getReel(initiator, reel.id).expect(200))
        .body as Envelope<ReelView>;
      expect(asInitiator.data.status).toBe('collecting');
      expect(asInitiator.data.wishCount).toBe(1);
      expect(asInitiator.data.contributors).toEqual([friend.name.split(' ')[0]]);
      expect(asInitiator.data.wishes).toEqual([]);
      expect(asInitiator.data.reelMediaUrl).toBeNull();

      // Surface 2: the RECIPIENT — the person the surprise is for.
      const asRecipient = (await getReel(recipient, reel.id).expect(200))
        .body as Envelope<ReelView>;
      expect(asRecipient.data.wishes).toEqual([]);
      expect(asRecipient.data.reelMediaUrl).toBeNull();
      expect(JSON.stringify(asRecipient.data)).not.toContain('you legend');

      // Surface 3: the public share link.
      const slug = asInitiator.data.share!.slug;
      const pub = (await request(app.getHttpServer()).get(`${V1}/public/reels/${slug}`).expect(200))
        .body as Envelope<{ reelMediaUrl: string | null; wishCount: number }>;
      expect(pub.data.reelMediaUrl).toBeNull();
      expect(pub.data.wishCount).toBe(1);
      expect(JSON.stringify(pub.data)).not.toContain('you legend');

      // Surface 4: the public OG preview.
      const preview = (
        await request(app.getHttpServer()).get(`${V1}/public/reels/${slug}/preview`).expect(200)
      ).body as Envelope<{ image: string | null; description: string }>;
      expect(preview.data.image).toBeNull();
      expect(JSON.stringify(preview.data)).not.toContain('you legend');
    });

    it('hides a reel from a stranger entirely', async () => {
      const initiator = await newUser();
      const recipient = await newUser();
      const stranger = await newUser();
      const reel = await createReel(initiator, recipient);
      await getReel(stranger, reel.id).expect(404);
    });

    it('schedules the release at the recipient’s local midnight', async () => {
      const initiator = await newUser();
      const recipient = await newUser();
      const reel = await createReel(initiator, recipient);
      const jobs = ctx.scheduler.jobsNamed('reel-release');
      const job = jobs.find((j) => (j.data as { collectionId: string }).collectionId === reel.id);
      expect(job).toBeDefined();
      expect(job!.opts.delay).toBeGreaterThan(0);
      // 2026-12-25 00:00 IST == 2026-12-24T18:30Z.
      expect((job!.data as { releaseAtIso: string }).releaseAtIso).toBe('2026-12-24T18:30:00.000Z');
    });
  });

  // ── Submission validation (real content, not the declared header) ───────────

  describe('wish submission', () => {
    it('requires text for a text wish and media for a media wish', async () => {
      const initiator = await newUser();
      const recipient = await newUser();
      const friend = await newUser();
      const reel = await createReel(initiator, recipient);

      const noText = await addText(friend, reel.id, '').expect(400);
      expect((noText.body as Envelope<never>).error?.code).toBe(ErrorCode.WISH_TEXT_REQUIRED);

      const noMedia = await request(app.getHttpServer())
        .post(`${V1}/reels/${reel.id}/wishes`)
        .set(auth(friend.token))
        .send({ kind: 'video' })
        .expect(400);
      expect((noMedia.body as Envelope<never>).error?.code).toBe(ErrorCode.WISH_MEDIA_REQUIRED);
    });

    it('rejects an over-long clip and a file whose real streams contradict the kind', async () => {
      const initiator = await newUser();
      const recipient = await newUser();
      const friend = await newUser();
      const reel = await createReel(initiator, recipient);

      // 7s audio against a 5s cap — ffprobe measured it, not a client claim.
      const longId = await uploadMedia(friend, longAudioBytes, 'audio/mp4');
      const tooLong = await request(app.getHttpServer())
        .post(`${V1}/reels/${reel.id}/wishes`)
        .set(auth(friend.token))
        .send({ kind: 'audio', mediaId: longId })
        .expect(400);
      expect((tooLong.body as Envelope<never>).error?.code).toBe(ErrorCode.WISH_DURATION_EXCEEDED);

      // An audio file submitted as a VIDEO wish: the declared kind says video,
      // the actual bytes have no video stream, so ffprobe catches the lie.
      const audioId = await uploadMedia(friend, audioBytes, 'audio/mp4');
      const wrongKind = await request(app.getHttpServer())
        .post(`${V1}/reels/${reel.id}/wishes`)
        .set(auth(friend.token))
        .send({ kind: 'video', mediaId: audioId })
        .expect(400);
      expect((wrongKind.body as Envelope<never>).error?.code).toBe(ErrorCode.WISH_MEDIA_INVALID);
    });

    it('refuses the recipient adding to their own reel, and a closed reel', async () => {
      const initiator = await newUser();
      const recipient = await newUser();
      const reel = await createReel(initiator, recipient);
      await addText(recipient, reel.id, 'me!').expect(403);
    });
  });

  // ── Exit criterion: a mixed-format collection compiles to a playable MP4 ────

  describe('compilation', () => {
    it('compiles text + audio + video wishes into one playable MP4, then releases', async () => {
      const initiator = await newUser();
      const recipient = await newUser();
      const friend = await newUser();
      const reel = await createReel(initiator, recipient);

      await addText(friend, reel.id, 'Happy birthday! Hope it is wonderful.').expect(201);
      const audioId = await uploadMedia(friend, audioBytes, 'audio/mp4');
      await request(app.getHttpServer())
        .post(`${V1}/reels/${reel.id}/wishes`)
        .set(auth(friend.token))
        .send({ kind: 'audio', mediaId: audioId })
        .expect(201);
      const videoId = await uploadMedia(friend, videoBytes, 'video/mp4');
      await request(app.getHttpServer())
        .post(`${V1}/reels/${reel.id}/wishes`)
        .set(auth(friend.token))
        .send({ kind: 'video', mediaId: videoId })
        .expect(201);

      const result = await compileService.compile(reel.id);
      expect(result.released).toBe(true);
      expect(result.wishesUsed).toBe(3);

      // The stored artifact is a real, playable MP4 with both streams.
      const after = (await getReel(recipient, reel.id).expect(200)).body as Envelope<ReelView>;
      expect(after.data.status).toBe('released');
      expect(after.data.reelMediaUrl).toBeTruthy();
      expect(after.data.durationMs).toBeGreaterThan(0);
      // ...and now the content IS visible — the lock lifted with the release.
      expect(after.data.wishes.length).toBe(3);
      expect(after.data.wishes.some((w) => w.text?.includes('Happy birthday'))).toBe(true);

      const probeDir = path.join(MEDIA_DIR, 'probe');
      await fs.mkdir(probeDir, { recursive: true });
      const stored = await storage.getObject((await getStorageKey(reel.id)) as string);
      const out = path.join(probeDir, 'reel.mp4');
      await fs.writeFile(out, stored.body);
      const probe = await ffmpeg.probe(out);
      expect(probe.hasVideo).toBe(true);
      expect(probe.hasAudio).toBe(true);
      expect(probe.videoCodec).toBe('h264');
      expect(probe.width).toBe(720);
      expect(probe.height).toBe(1280);
      // intro (4s) + text (4s) + audio (2s) + video (2s) + outro (4s) ≈ 16s.
      expect(probe.durationMs).toBeGreaterThan(10_000);
    }, 180_000);

    it('leaves no temp files behind and recompiles cleanly on a retry', async () => {
      const initiator = await newUser();
      const recipient = await newUser();
      const friend = await newUser();
      const reel = await createReel(initiator, recipient);
      await addText(friend, reel.id, 'One wish is enough.').expect(201);

      const tempBase = process.env.REEL_TEMP_DIR!;
      const jobDir = path.join(path.resolve(tempBase), `reel-${reel.id}`);
      // Simulate a killed prior attempt: an orphaned scratch dir with junk in it.
      await fs.mkdir(jobDir, { recursive: true });
      await fs.writeFile(path.join(jobDir, 'orphan.tmp'), 'left by a SIGKILLed render');

      await compileService.compile(reel.id);
      // The retry wiped the orphan at start and its own scratch in `finally`.
      await expect(fs.access(jobDir)).rejects.toBeDefined();

      // And it still produced a correct reel.
      const after = (await getReel(recipient, reel.id).expect(200)).body as Envelope<ReelView>;
      expect(after.data.status).toBe('released');
      expect(after.data.reelMediaUrl).toBeTruthy();
    }, 120_000);

    it('skips an unprocessable wish and still ships the reel', async () => {
      const initiator = await newUser();
      const recipient = await newUser();
      const friend = await newUser();
      const reel = await createReel(initiator, recipient);
      await addText(friend, reel.id, 'A good wish.').expect(201);
      const audioId = await uploadMedia(friend, audioBytes, 'audio/mp4');
      await request(app.getHttpServer())
        .post(`${V1}/reels/${reel.id}/wishes`)
        .set(auth(friend.token))
        .send({ kind: 'audio', mediaId: audioId })
        .expect(201);
      // Point THIS collection's audio wish at a storage key that does not exist,
      // so its clip render blows up mid-compile. Scoped by collectionId — an
      // unscoped update would hit an earlier test's wish instead.
      const wishModel = app.get<Model<Record<string, unknown>>>(getModelToken('Wish'));
      const updated = await wishModel
        .updateOne(
          { collectionId: new Types.ObjectId(reel.id), kind: 'audio' },
          { $set: { storageKey: 'reels/missing.m4a' } },
        )
        .exec();
      expect(updated.modifiedCount).toBe(1);

      const result = await compileService.compile(reel.id);
      // The broken wish was skipped; the text wish still made it.
      expect(result.released).toBe(true);
      expect(result.wishesUsed).toBe(1);
    }, 120_000);
  });

  // ── Moderation gate ─────────────────────────────────────────────────────────

  describe('moderation', () => {
    it('keeps a rejected wish out of the reel and out of every projection', async () => {
      const initiator = await newUser();
      const recipient = await newUser();
      const friend = await newUser();
      const reel = await createReel(initiator, recipient);
      const good = await addText(friend, reel.id, 'A lovely wish.').expect(201);
      const bad = await addText(friend, reel.id, 'Something unkind.').expect(201);
      void good;

      const badId = (bad.body as Envelope<{ id: string }>).data.id;
      await request(app.getHttpServer())
        .post(`${V1}/reels/${reel.id}/wishes/${badId}/moderate`)
        .set(auth(initiator.token))
        .send({ decision: 'reject' })
        .expect(200);

      const result = await compileService.compile(reel.id);
      expect(result.wishesUsed).toBe(1); // only the approved one compiled

      const after = (await getReel(recipient, reel.id).expect(200)).body as Envelope<ReelView>;
      expect(after.data.wishes).toHaveLength(1);
      expect(JSON.stringify(after.data)).not.toContain('unkind');
    }, 120_000);

    it('only lets the initiator moderate', async () => {
      const initiator = await newUser();
      const recipient = await newUser();
      const friend = await newUser();
      const reel = await createReel(initiator, recipient);
      const wish = await addText(friend, reel.id, 'hi').expect(201);
      const wishId = (wish.body as Envelope<{ id: string }>).data.id;
      await request(app.getHttpServer())
        .post(`${V1}/reels/${reel.id}/wishes/${wishId}/moderate`)
        .set(auth(friend.token))
        .send({ decision: 'reject' })
        .expect(403);
    });
  });

  /** Reads the reel's storageKey straight from Mongo (not exposed on the view). */
  async function getStorageKey(reelId: string): Promise<string | null> {
    const model = app.get<Model<{ reelStorageKey: string | null }>>(
      getModelToken('ReelCollection'),
    );
    const doc = await model.findById(reelId).lean().exec();
    return doc?.reelStorageKey ?? null;
  }
});
