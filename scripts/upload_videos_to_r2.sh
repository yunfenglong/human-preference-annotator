#!/usr/bin/env bash
set -euo pipefail

bucket_name="${1:-human-preference-videos}"
source_ref="${2:-feae999}"
work_dir="$(mktemp -d)"

cleanup() {
  if [[ -n "${work_dir:-}" && -d "$work_dir" ]]; then
    rm -rf -- "$work_dir"
  fi
}
trap cleanup EXIT

echo "Extracting frontend/videos from Git ref $source_ref..."
git archive "$source_ref" frontend/videos | tar -x -C "$work_dir"

video_root="$work_dir/frontend/videos"
video_count="$(find "$video_root" -type f -name '*.mp4' | wc -l | tr -d ' ')"
if [[ "$video_count" -eq 0 ]]; then
  echo "No MP4 files found at $source_ref:frontend/videos" >&2
  exit 1
fi

echo "Uploading $video_count videos to R2 bucket $bucket_name..."
while IFS= read -r -d '' video_path; do
  object_key="${video_path#"$work_dir/frontend/"}"
  npx wrangler r2 object put "$bucket_name/$object_key" \
    --file "$video_path" \
    --content-type video/mp4 \
    --remote
done < <(find "$video_root" -type f -name '*.mp4' -print0)

echo "Uploaded $video_count videos. Object keys retain the videos/... catalogue paths."
