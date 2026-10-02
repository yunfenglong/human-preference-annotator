#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <video-directory-or-tar-archive> [r2-bucket]" >&2
  exit 2
fi

source_path="$1"
bucket_name="${2:-human-preference-videos}"
work_dir=""

cleanup() {
  if [[ -n "${work_dir:-}" && -d "$work_dir" ]]; then
    rm -rf -- "$work_dir"
  fi
}
trap cleanup EXIT

if [[ -f "$source_path" ]]; then
  work_dir="$(mktemp -d)"
  echo "Extracting video archive $source_path..."
  tar -xf "$source_path" -C "$work_dir"
  video_root="$work_dir/frontend/videos"
elif [[ -d "$source_path/frontend/videos" ]]; then
  video_root="$source_path/frontend/videos"
elif [[ -d "$source_path/videos" ]]; then
  video_root="$source_path/videos"
elif [[ -d "$source_path" && "$(basename "$source_path")" == "videos" ]]; then
  video_root="$source_path"
else
  echo "Could not find a videos directory in $source_path" >&2
  exit 1
fi

video_count="$(find "$video_root" -type f -name '*.mp4' | wc -l | tr -d ' ')"
if [[ "$video_count" -eq 0 ]]; then
  echo "No MP4 files found under $video_root" >&2
  exit 1
fi

echo "Uploading $video_count videos to R2 bucket $bucket_name..."
while IFS= read -r -d '' video_path; do
  relative_path="${video_path#"$video_root/"}"
  object_key="videos/$relative_path"
  npx wrangler r2 object put "$bucket_name/$object_key" \
    --file "$video_path" \
    --content-type video/mp4 \
    --remote
done < <(find "$video_root" -type f -name '*.mp4' -print0)

echo "Uploaded $video_count videos. Object keys retain the videos/... catalogue paths."
