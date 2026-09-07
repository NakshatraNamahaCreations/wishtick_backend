import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { spawn } from 'node:child_process';
import ffmpegStatic from 'ffmpeg-static';
import { path as ffprobeStatic } from 'ffprobe-static';
import type { AppConfig } from 'src/config/configuration';

export interface ProbeResult {
  durationMs: number;
  hasVideo: boolean;
  hasAudio: boolean;
  videoCodec: string | null;
  audioCodec: string | null;
  width: number | null;
  height: number | null;
  /** The container format ffprobe detected — the real content type, not a header. */
  formatName: string;
}

interface FfprobeJson {
  format?: { duration?: string; format_name?: string };
  streams?: { codec_type?: string; codec_name?: string; width?: number; height?: number }[];
}

/**
 * The one place a child ffmpeg/ffprobe process is spawned.
 *
 * Every invocation is an isolated process with a HARD timeout that SIGKILLs a
 * runaway render — an ffmpeg that hangs on a malformed input must never wedge the
 * worker. Non-zero exits reject with the tail of stderr so a failure is
 * diagnosable. The binaries are the bundled `ffmpeg-static` / `ffprobe-static`,
 * so there is no host dependency to install.
 */
@Injectable()
export class FfmpegService {
  private readonly ffmpeg = ffmpegStatic as unknown as string;
  private readonly ffprobe = ffprobeStatic;
  private readonly timeoutMs: number;

  constructor(config: ConfigService<AppConfig, true>) {
    this.timeoutMs = config.get('reels.ffmpegTimeoutMs', { infer: true });
  }

  /** Reads real duration/codecs/format from the bytes — the true content check. */
  async probe(filePath: string): Promise<ProbeResult> {
    const out = await this.exec(this.ffprobe, [
      '-v',
      'quiet',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      filePath,
    ]);
    const json = JSON.parse(out) as FfprobeJson;
    const streams = json.streams ?? [];
    const video = streams.find((s) => s.codec_type === 'video');
    const audio = streams.find((s) => s.codec_type === 'audio');
    return {
      durationMs: Math.round(Number(json.format?.duration ?? 0) * 1000),
      hasVideo: !!video,
      hasAudio: !!audio,
      videoCodec: video?.codec_name ?? null,
      audioCodec: audio?.codec_name ?? null,
      width: video?.width ?? null,
      height: video?.height ?? null,
      formatName: json.format?.format_name ?? '',
    };
  }

  /** Runs ffmpeg with the given args. Always overwrites (`-y`) and rejects on failure. */
  async run(args: string[]): Promise<void> {
    await this.exec(this.ffmpeg, ['-y', '-loglevel', 'error', ...args]);
  }

  private exec(bin: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, this.timeoutMs);

      child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
      child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (timedOut) {
          reject(new Error(`ffmpeg timed out after ${this.timeoutMs}ms`));
        } else if (code === 0) {
          resolve(stdout);
        } else {
          reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-500)}`));
        }
      });
    });
  }
}
