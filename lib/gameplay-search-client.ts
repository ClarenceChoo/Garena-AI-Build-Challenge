import {
  ALL_FORMATS,
  AudioSample,
  AudioSampleSink,
  AudioSampleSource,
  BlobSource,
  BufferTarget,
  CanvasSink,
  CanvasSource,
  Conversion,
  Input,
  Mp4OutputFormat,
  Output,
  VideoSampleSink,
  WebMOutputFormat,
  canEncodeAudio,
  canEncodeVideo,
} from "mediabunny";
import type {
  GameplayAudioFeature,
  GameplayEvidenceFrame,
  GameplayTranscriptSegment,
  HighlightPlan,
} from "./gameplay-search-types";
import { GAMEPLAY_SEARCH_LIMITS } from "./gameplay-search-types";

export interface AdaptiveSegmentEvidence {
  frames: GameplayEvidenceFrame[];
  audioFeatures: GameplayAudioFeature[];
}

export interface ReelSource {
  id: string;
  file: File;
}

export interface RenderedGameplayReel {
  blob: Blob;
  extension: "mp4" | "webm";
  mimeType: string;
}

interface ScanPoint {
  timestampMs: number;
  visualScore: number;
  hudScore: number;
  rms: number;
  peak: number;
  signature: Uint8Array;
}

interface MediaSinks {
  input: Input;
  video: VideoSampleSink;
  audio: AudioSampleSink | null;
}

function abortIfNeeded(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Processing canceled.", "AbortError");
}

function canvasContext(canvas: HTMLCanvasElement | OffscreenCanvas) {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context || !("getImageData" in context)) throw new Error("Canvas analysis is unavailable in this browser.");
  return context as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
}

function visualSignature(canvas: HTMLCanvasElement | OffscreenCanvas): Uint8Array {
  const width = 64;
  const height = 36;
  const reduced = typeof document === "undefined"
    ? new OffscreenCanvas(width, height)
    : Object.assign(document.createElement("canvas"), { width, height });
  const context = canvasContext(reduced);
  context.drawImage(canvas, 0, 0, width, height);
  const data = context.getImageData(0, 0, width, height).data;
  const signature = new Uint8Array(width * height);
  for (let pixel = 0, index = 0; pixel < data.length; pixel += 4, index += 1) {
    signature[index] = Math.round(data[pixel] * 0.299 + data[pixel + 1] * 0.587 + data[pixel + 2] * 0.114);
  }
  return signature;
}

function signatureDifference(current: Uint8Array, previous: Uint8Array | null) {
  if (!previous || current.length !== previous.length) return { visual: 1, hud: 1 };
  const width = 64;
  const height = 36;
  let total = 0;
  let hudTotal = 0;
  let hudCount = 0;
  for (let index = 0; index < current.length; index += 1) {
    const delta = Math.abs(current[index] - previous[index]) / 255;
    total += delta;
    const x = index % width;
    const y = Math.floor(index / width);
    const inHudBand = y < height * 0.3 || y > height * 0.72 || x < width * 0.22 || x > width * 0.78;
    if (inHudBand) {
      hudTotal += delta;
      hudCount += 1;
    }
  }
  return { visual: total / current.length, hud: hudTotal / Math.max(1, hudCount) };
}

function audioEnergy(sample: AudioSample | null): { rms: number; peak: number } {
  if (!sample) return { rms: 0, peak: 0 };
  try {
    const buffer = sample.toAudioBuffer();
    let sum = 0;
    let peak = 0;
    let count = 0;
    for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
      const values = buffer.getChannelData(channel);
      const step = Math.max(1, Math.floor(values.length / 2_048));
      for (let index = 0; index < values.length; index += step) {
        const value = Math.abs(values[index]);
        sum += value * value;
        peak = Math.max(peak, value);
        count += 1;
      }
    }
    return { rms: Math.min(1, Math.sqrt(sum / Math.max(1, count))), peak: Math.min(1, peak) };
  } finally {
    sample.close();
  }
}

async function canvasToJpegDataUrl(canvas: HTMLCanvasElement | OffscreenCanvas): Promise<string> {
  if (canvas instanceof HTMLCanvasElement) return canvas.toDataURL("image/jpeg", 0.76);
  const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.76 });
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("The evidence frame could not be encoded."));
    reader.readAsDataURL(blob);
  });
}

function segmentTimes(startMs: number, endMs: number): number[] {
  const times: number[] = [];
  for (let value = startMs; value < endMs; value += GAMEPLAY_SEARCH_LIMITS.scanIntervalMs) {
    times.push(value);
  }
  if (times.length < 2) times.push(Math.max(startMs, endMs - 50));
  return [...new Set(times)].sort((a, b) => a - b);
}

export async function readGameplayDuration(file: File): Promise<number> {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
  try {
    if (!(await input.canRead())) throw new Error("This browser cannot read that video format.");
    const duration = await input.getDurationFromMetadata() ?? await input.computeDuration();
    return Math.round(duration * 1_000);
  } finally {
    input.dispose();
  }
}

export async function extractAdaptiveSegmentEvidence(
  file: File,
  clipId: string,
  segmentId: string,
  startMs: number,
  endMs: number,
  signal?: AbortSignal,
): Promise<AdaptiveSegmentEvidence> {
  abortIfNeeded(signal);
  const input = new Input({
    formats: ALL_FORMATS,
    source: new BlobSource(file, { maxCacheSize: 16 * 1024 * 1024 }),
  });
  try {
    if (!(await input.canRead())) throw new Error(`${file.name} is not readable in this browser.`);
    const videoTrack = await input.getPrimaryVideoTrack();
    if (!videoTrack) throw new Error(`${file.name} has no video track.`);
    const audioTrack = await input.getPrimaryAudioTrack();
    const lowSink = new CanvasSink(videoTrack, { width: 320, fit: "contain", poolSize: 2 });
    const highSink = new CanvasSink(videoTrack, { width: 960, fit: "contain", poolSize: 2 });
    const audioSink = audioTrack ? new AudioSampleSink(audioTrack) : null;
    const times = segmentTimes(startMs, endMs);
    const points: ScanPoint[] = [];
    let previous: Uint8Array | null = null;
    const canvasIterator = lowSink.canvasesAtTimestamps(times.map((time) => time / 1_000));
    const audioIterator = audioSink?.samplesAtTimestamps(times.map((time) => time / 1_000));
    for (let index = 0; index < times.length; index += 1) {
      abortIfNeeded(signal);
      const canvasResult = await canvasIterator.next();
      const audioResult = audioIterator ? await audioIterator.next() : null;
      if (!canvasResult.value) continue;
      const signature = visualSignature(canvasResult.value.canvas);
      const difference = signatureDifference(signature, previous);
      previous = signature;
      const energy = audioEnergy(audioResult?.value ?? null);
      points.push({
        timestampMs: times[index],
        visualScore: difference.visual,
        hudScore: difference.hud,
        rms: energy.rms,
        peak: energy.peak,
        signature,
      });
    }

    const contextPoints = points.filter((point) =>
      (point.timestampMs - startMs) % GAMEPLAY_SEARCH_LIMITS.contextIntervalMs < GAMEPLAY_SEARCH_LIMITS.scanIntervalMs,
    );
    const contextIds = new Set(contextPoints.map((point) => point.timestampMs));
    const adaptive = points
      .filter((point) => !contextIds.has(point.timestampMs))
      .map((point) => ({
        ...point,
        score: point.visualScore * 0.42 + point.hudScore * 0.43 + point.rms * 0.1 + point.peak * 0.05,
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(0, GAMEPLAY_SEARCH_LIMITS.maximumFramesPerSegment - contextPoints.length));
    const selected = [...contextPoints, ...adaptive]
      .sort((a, b) => a.timestampMs - b.timestampMs)
      .slice(0, GAMEPLAY_SEARCH_LIMITS.maximumFramesPerSegment);
    const audioFeatures = points.map(({ timestampMs, rms, peak }) => ({ timestampMs, rms, peak }));
    const maxAudioRms = Math.max(0.0001, ...points.map((point) => point.rms));
    const frames: GameplayEvidenceFrame[] = [];
    const highIterator = highSink.canvasesAtTimestamps(selected.map((point) => point.timestampMs / 1_000));
    for (const point of selected) {
      abortIfNeeded(signal);
      const result = await highIterator.next();
      if (!result.value) continue;
      const isContext = contextIds.has(point.timestampMs);
      const reason: GameplayEvidenceFrame["reason"] = isContext
        ? "context"
        : point.rms >= maxAudioRms * 0.82
          ? "audio_peak"
          : point.hudScore >= point.visualScore
            ? "hud_change"
            : "visual_change";
      const imageDataUrl = await canvasToJpegDataUrl(result.value.canvas);
      const canvas = result.value.canvas;
      frames.push({
        id: `${segmentId}-frame-${point.timestampMs}`,
        timestampMs: point.timestampMs,
        imageDataUrl,
        width: canvas.width,
        height: canvas.height,
        detail: isContext ? "low" : "high",
        reason,
      });
    }
    if (frames.length < 2) throw new Error("Too few gameplay frames could be decoded from this segment.");
    return { frames, audioFeatures };
  } finally {
    input.dispose();
  }
}

export async function createConsentedAudioChunk(
  file: File,
  startMs: number,
  endMs: number,
  signal?: AbortSignal,
): Promise<Blob | null> {
  abortIfNeeded(signal);
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
  const audioTrack = await input.getPrimaryAudioTrack();
  if (!audioTrack) {
    input.dispose();
    return null;
  }
  const target = new BufferTarget();
  const output = new Output({ format: new WebMOutputFormat(), target });
  const conversion = await Conversion.init({
    input,
    output,
    tracks: "primary",
    video: { discard: true },
    audio: {
      codec: "opus",
      bitrate: 24_000,
      numberOfChannels: 1,
      sampleRate: 16_000,
    },
    trim: { start: startMs / 1_000, end: endMs / 1_000 },
    showWarnings: false,
  });
  try {
    if (!conversion.isValid) return null;
    if (signal) signal.addEventListener("abort", () => void conversion.cancel(), { once: true });
    await conversion.execute();
    abortIfNeeded(signal);
    return target.buffer ? new Blob([target.buffer], { type: "audio/webm" }) : null;
  } finally {
    input.dispose();
  }
}

export function transcriptsForSegment(
  transcript: GameplayTranscriptSegment[],
  startMs: number,
  endMs: number,
): GameplayTranscriptSegment[] {
  return transcript.filter((segment) => segment.endMs >= startMs && segment.startMs <= endMs);
}

async function openMediaSinks(file: File): Promise<MediaSinks> {
  const input = new Input({
    formats: ALL_FORMATS,
    source: new BlobSource(file, { maxCacheSize: 24 * 1024 * 1024 }),
  });
  if (!(await input.canRead())) {
    input.dispose();
    throw new Error(`${file.name} cannot be decoded for reel export.`);
  }
  const videoTrack = await input.getPrimaryVideoTrack();
  if (!videoTrack) {
    input.dispose();
    throw new Error(`${file.name} has no video track.`);
  }
  const audioTrack = await input.getPrimaryAudioTrack();
  return {
    input,
    video: new VideoSampleSink(videoTrack),
    audio: audioTrack ? new AudioSampleSink(audioTrack) : null,
  };
}

function wrapCaption(context: CanvasRenderingContext2D, text: string, maximumWidth: number): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (context.measureText(candidate).width <= maximumWidth || !current) current = candidate;
    else {
      lines.push(current);
      current = word;
      if (lines.length === 2) break;
    }
  }
  if (current && lines.length < 2) lines.push(current);
  return lines.slice(0, 2);
}

function drawReelFrame(
  context: CanvasRenderingContext2D,
  sample: Awaited<ReturnType<VideoSampleSink["getSample"]>>,
  plan: HighlightPlan,
  caption: string,
  outputTimeSeconds: number,
): void {
  if (!sample) return;
  const { width, height } = context.canvas;
  context.save();
  context.fillStyle = "#050609";
  context.fillRect(0, 0, width, height);
  if (plan.aspectRatio === "9:16") {
    context.filter = "blur(28px) brightness(0.48) saturate(1.2)";
    sample.drawWithFit(context, { fit: "cover" });
    context.filter = "none";
    context.fillStyle = "rgba(3,4,7,.16)";
    context.fillRect(0, 0, width, height);
  }
  sample.drawWithFit(context, { fit: "contain" });
  const gradient = context.createLinearGradient(0, height * 0.62, 0, height);
  gradient.addColorStop(0, "rgba(4,5,8,0)");
  gradient.addColorStop(1, "rgba(4,5,8,.92)");
  context.fillStyle = gradient;
  context.fillRect(0, height * 0.55, width, height * 0.45);
  const side = Math.round(width * 0.065);
  const captionSize = Math.round(width * (plan.aspectRatio === "9:16" ? 0.054 : 0.036));
  context.font = `800 ${captionSize}px Inter, Arial, sans-serif`;
  context.fillStyle = "#ffffff";
  context.textBaseline = "bottom";
  const lines = wrapCaption(context, caption, width - side * 2);
  lines.reverse().forEach((line, index) => {
    context.fillText(line, side, height - side - index * captionSize * 1.2);
  });
  context.fillStyle = "#35e4ff";
  context.font = `800 ${Math.round(captionSize * 0.42)}px ui-monospace, monospace`;
  context.fillText("UNSEEN  ·  AI-CURATED / EVIDENCE-LINKED", side, height - side - lines.length * captionSize * 1.32);
  if (outputTimeSeconds < 1.5) {
    context.fillStyle = "rgba(4,5,8,.72)";
    context.fillRect(0, 0, width, height);
    context.fillStyle = "#ed1c2e";
    context.fillRect(side, height * 0.24, Math.round(width * 0.12), 7);
    context.fillStyle = "#ffffff";
    context.font = `900 ${Math.round(width * (plan.aspectRatio === "9:16" ? 0.07 : 0.058))}px Inter, Arial, sans-serif`;
    const titleLines = wrapCaption(context, plan.title, width - side * 2);
    titleLines.forEach((line, index) => context.fillText(line, side, height * 0.48 + index * width * 0.07));
  }
  context.restore();
}

function fadeAudioSample(sample: AudioSample, beatSpans: Array<{ start: number; end: number }>): AudioSample {
  const span = beatSpans.find((candidate) => sample.timestamp < candidate.end && sample.timestamp + sample.duration > candidate.start);
  if (!span) return sample;
  const buffer = sample.toAudioBuffer();
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const values = buffer.getChannelData(channel);
    for (let index = 0; index < values.length; index += 1) {
      const time = sample.timestamp + index / buffer.sampleRate;
      const fadeIn = Math.min(1, Math.max(0, (time - span.start) / 0.1));
      const fadeOut = Math.min(1, Math.max(0, (span.end - time) / 0.1));
      values[index] *= Math.min(fadeIn, fadeOut);
    }
  }
  const replacement = AudioSample.fromAudioBuffer(buffer, sample.timestamp)[0];
  sample.close();
  return replacement;
}

export async function renderGameplayReel(
  sources: ReelSource[],
  plan: HighlightPlan,
  includeAudio: boolean,
  onProgress: (progress: number) => void,
  signal?: AbortSignal,
): Promise<RenderedGameplayReel> {
  abortIfNeeded(signal);
  const sourceFiles = new Map(sources.map((source) => [source.id, source.file]));
  const requiredIds = [...new Set(plan.beats.map((beat) => beat.clipId))];
  const sinks = new Map<string, MediaSinks>();
  for (const id of requiredIds) {
    const file = sourceFiles.get(id);
    if (!file) throw new Error(`The reel references missing source ${id}.`);
    sinks.set(id, await openMediaSinks(file));
  }
  const width = plan.aspectRatio === "9:16" ? 720 : 1280;
  const height = plan.aspectRatio === "9:16" ? 1280 : 720;
  const mp4Video = await canEncodeVideo("avc", { width, height, bitrate: 4_000_000 });
  const mp4Audio = !includeAudio || await canEncodeAudio("aac", { numberOfChannels: 2, sampleRate: 48_000, bitrate: 128_000 });
  const useMp4 = mp4Video && mp4Audio;
  const videoCodec = useMp4 ? "avc" : "vp9";
  const audioCodec = useMp4 ? "aac" : "opus";
  if (!useMp4 && !(await canEncodeVideo("vp9", { width, height, bitrate: 3_500_000 }))) {
    sinks.forEach((value) => value.input.dispose());
    throw new Error("This browser cannot encode MP4 or WebM reels. Try the latest Chrome or Edge.");
  }
  const hasAudio = includeAudio && [...sinks.values()].some((value) => value.audio);
  if (hasAudio && !(await canEncodeAudio(audioCodec, { numberOfChannels: 2, sampleRate: 48_000, bitrate: 128_000 }))) {
    sinks.forEach((value) => value.input.dispose());
    throw new Error("This browser cannot encode the reel audio track.");
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas video export is unavailable.");
  const target = new BufferTarget();
  const output = new Output({
    format: useMp4 ? new Mp4OutputFormat({ fastStart: "in-memory" }) : new WebMOutputFormat(),
    target,
  });
  const videoSource = new CanvasSource(canvas, {
    codec: videoCodec,
    bitrate: useMp4 ? 4_000_000 : 3_500_000,
    keyFrameInterval: 2,
    hardwareAcceleration: "prefer-hardware",
  });
  output.addVideoTrack(videoSource);
  const beatSpans: Array<{ start: number; end: number }> = [];
  let timelineSeconds = 0;
  for (const beat of plan.beats) {
    const duration = (beat.endMs - beat.startMs) / 1_000;
    beatSpans.push({ start: timelineSeconds, end: timelineSeconds + duration });
    timelineSeconds += duration;
  }
  const audioSource = hasAudio
    ? new AudioSampleSource({
        codec: audioCodec,
        bitrate: 128_000,
        transform: {
          numberOfChannels: 2,
          sampleRate: 48_000,
          sampleFormat: "f32",
          process: (sample) => fadeAudioSample(sample, beatSpans),
        },
      })
    : null;
  if (audioSource) output.addAudioTrack(audioSource);
  await output.start();
  const framesPerSecond = 30;
  const frameDuration = 1 / framesPerSecond;
  const totalFrames = Math.max(1, Math.ceil(timelineSeconds * framesPerSecond));
  let completedFrames = 0;
  let outputOffsetSeconds = 0;
  try {
    for (const beat of plan.beats) {
      abortIfNeeded(signal);
      const media = sinks.get(beat.clipId);
      if (!media) continue;
      const startSeconds = beat.startMs / 1_000;
      const endSeconds = beat.endMs / 1_000;
      const sourceTimes: number[] = [];
      for (let time = startSeconds; time < endSeconds - 0.0001; time += frameDuration) sourceTimes.push(time);
      const samples = media.video.samplesAtTimestamps(sourceTimes);
      for (let index = 0; index < sourceTimes.length; index += 1) {
        abortIfNeeded(signal);
        const result = await samples.next();
        const sample = result.value;
        if (!sample) continue;
        const outputTime = outputOffsetSeconds + index * frameDuration;
        drawReelFrame(context, sample, plan, beat.caption, outputTime);
        sample.close();
        await videoSource.add(outputTime, frameDuration, { keyFrame: completedFrames % (framesPerSecond * 2) === 0 });
        completedFrames += 1;
        if (completedFrames % 15 === 0) onProgress(Math.min(0.88, completedFrames / totalFrames * 0.88));
      }
      if (audioSource && media.audio) {
        for await (let sample of media.audio.samples(startSeconds, endSeconds)) {
          abortIfNeeded(signal);
          if (sample.timestamp < startSeconds) {
            const firstFrame = Math.max(0, Math.round((startSeconds - sample.timestamp) * sample.sampleRate));
            const trimmed = sample.trim(firstFrame);
            sample.close();
            sample = trimmed;
          }
          if (sample.timestamp + sample.duration > endSeconds) {
            const keepFrames = Math.max(1, Math.floor((endSeconds - sample.timestamp) * sample.sampleRate));
            const trimmed = sample.trim(0, Math.min(sample.numberOfFrames, keepFrames));
            sample.close();
            sample = trimmed;
          }
          sample.setTimestamp(outputOffsetSeconds + Math.max(0, sample.timestamp - startSeconds));
          await audioSource.add(sample);
          sample.close();
        }
      }
      outputOffsetSeconds += endSeconds - startSeconds;
    }
    onProgress(0.94);
    await output.finalize();
    abortIfNeeded(signal);
    if (!target.buffer) throw new Error("The reel encoder returned no video data.");
    const mimeType = await output.getMimeType();
    onProgress(1);
    return {
      blob: new Blob([target.buffer], { type: mimeType }),
      extension: useMp4 ? "mp4" : "webm",
      mimeType,
    };
  } catch (error) {
    if (output.state !== "finalized" && output.state !== "canceled") await output.cancel().catch(() => undefined);
    throw error;
  } finally {
    sinks.forEach((value) => value.input.dispose());
  }
}
