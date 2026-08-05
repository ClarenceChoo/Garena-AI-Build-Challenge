#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd "$(dirname "$0")/.." && pwd)"
task_tmp="$(mktemp -d /private/tmp/unseen-demo-media.XXXXXX)"
trap 'rm -rf "$task_tmp"' EXIT

say -v Samantha -r 205 -o "$task_tmp/miko-flash.aiff" "That was meant for them. Nobody saw that, right?"
say -v Daniel -r 215 -o "$task_tmp/rin-call.aiff" "Two wrapping. Stay main. I've got it."
say -v Samantha -r 220 -o "$task_tmp/miko-open.aiff" "Swing on me. Last charge is gone."
say -v Boing -r 245 -o "$task_tmp/laughter.aiff" "Ha ha ha! No way!"
say -v "Good News" -r 230 -o "$task_tmp/celebration.aiff" "Let's go! What a round!"

for voice_file in "$task_tmp"/*.aiff; do
  if [ "$(wc -c < "$voice_file")" -le 8192 ]; then
    echo "Speech synthesis produced an empty track: $voice_file" >&2
    exit 1
  fi
done

for player in ace rin miko; do
  case "$player" in
    ace) source_offset_ms=0 ;;
    rin) source_offset_ms=2840 ;;
    miko) source_offset_ms=-1060 ;;
  esac
  miko_flash_ms=$((523180 + source_offset_ms))
  rin_call_ms=$((683450 + source_offset_ms))
  miko_open_ms=$((690050 + source_offset_ms))
  laughter_ms=$((523970 + source_offset_ms))
  celebration_ms=$((701900 + source_offset_ms))

  ffmpeg -hide_banner -loglevel warning -y \
    -f lavfi -i "anullsrc=r=48000:cl=stereo:d=828" \
    -i "$task_tmp/miko-flash.aiff" \
    -i "$task_tmp/rin-call.aiff" \
    -i "$task_tmp/miko-open.aiff" \
    -i "$task_tmp/laughter.aiff" \
    -i "$task_tmp/celebration.aiff" \
    -filter_complex "[1:a]aformat=sample_rates=48000:channel_layouts=stereo,adelay=${miko_flash_ms}|${miko_flash_ms},volume=1.25[v1];[2:a]aformat=sample_rates=48000:channel_layouts=stereo,adelay=${rin_call_ms}|${rin_call_ms},volume=1.2[v2];[3:a]aformat=sample_rates=48000:channel_layouts=stereo,adelay=${miko_open_ms}|${miko_open_ms},volume=1.2[v3];[4:a]aformat=sample_rates=48000:channel_layouts=stereo,adelay=${laughter_ms}|${laughter_ms},volume=1.1[v4];[5:a]aformat=sample_rates=48000:channel_layouts=stereo,adelay=${celebration_ms}|${celebration_ms},volume=1.15[v5];[0:a][v1][v2][v3][v4][v5]amix=inputs=6:duration=first:normalize=0,alimiter=limit=0.92[a]" \
    -map "[a]" -c:a aac -b:a 32k "$task_tmp/$player-audio.m4a"

  ffmpeg -hide_banner -loglevel warning -y \
    -f lavfi -i "color=c=0x071019:s=960x540:d=828:r=15" \
    -i "$task_tmp/$player-audio.m4a" \
    -filter_complex_script "$project_dir/assets/demo/$player.filter" \
    -map "[v]" -map 1:a \
    -c:v libx264 -preset ultrafast -crf 25 -pix_fmt yuv420p \
    -c:a aac -b:a 32k -t 828 -movflags +faststart \
    "$project_dir/public/demo/$player.mp4"
done

shasum -a 256 "$project_dir"/public/demo/*.mp4
