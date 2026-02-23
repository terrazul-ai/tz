#!/usr/bin/env bash
set -euo pipefail

release_version=""
staging_root=""
run_id=""
run_url=""
repo_override="${GITHUB_REPOSITORY:-terrazul-ai/terrazul}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --release-version)
      release_version="$2"
      shift 2
      ;;
    --tmp)
      staging_root="$2"
      shift 2
      ;;
    --run-id)
      run_id="$2"
      shift 2
      ;;
    --run-url)
      run_url="$2"
      shift 2
      ;;
    --repo)
      repo_override="$2"
      shift 2
      ;;
    *)
      echo "stage_release.sh: unknown argument $1" >&2
      exit 1
      ;;
  esac
done

if [[ -z "$release_version" ]]; then
  echo "stage_release.sh: --release-version is required" >&2
  exit 1
fi
if [[ -z "$staging_root" ]]; then
  echo "stage_release.sh: --tmp staging directory is required" >&2
  exit 1
fi
if [[ -z "$run_url" && -n "$run_id" ]]; then
  run_url="https://github.com/${repo_override}/actions/runs/${run_id}"
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
package_root="${staging_root%/}/package"
bin_dir="${package_root}/bin"
dist_dir="${package_root}/dist"

mkdir -p "$bin_dir"
mkdir -p "$dist_dir"

cp "$repo_root/bin/app.mjs" "$bin_dir/app.mjs"
cp "$repo_root/README.md" "$package_root/README.md"

if [[ -d "$repo_root/dist" ]]; then
  rsync -a --delete "$repo_root/dist/" "$dist_dir/"
fi

if [[ -d "$dist_dir/sea" ]]; then
  rm -rf "$dist_dir/sea"
fi

if [[ ! -f "$dist_dir/manifest.json" ]]; then
  echo "stage_release.sh: dist/manifest.json not found; run build-sea-manifest first" >&2
  exit 1
fi

jq \
  --arg version "$release_version" \
  'del(.private) |
   .version = $version |
   .bin = {tz: "bin/app.mjs"} |
   .files = ["bin", "dist", "README.md"] |
   .engines.node = ">=20.0.0" |
   .type = "module" |
   .dependencies = {} |
   del(.devDependencies)' \
  "$repo_root/package.json" > "$package_root/package.json"

echo "Staged package at $package_root"
