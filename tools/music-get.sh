#!/bin/sh
# Get the sound out of a YouTube link, ready to open in the editor.
#
#   ./music-get.sh "https://www.youtube.com/watch?v=..."
#   ./music-get.sh -o ~/Music/skate URL URL URL
#
# This is a thin wrapper around yt-dlp, which does all the real work. It saves
# the audio exactly as it already exists on the other end — nothing is
# converted and nothing is re-encoded, so ffmpeg is not needed and no quality
# is thrown away before you have even started cutting.
#
# The Windows equivalent is music-get.cmd next to this file. Keep the two in
# step: same options, same defaults, same messages.

set -eu

out_dir=.
playlist=--no-playlist

usage() {
  cat <<'EOF'
Get the sound out of a YouTube link.

  music-get.sh [options] URL [URL ...]

  -o DIR      where to put the files (default: here)
  --playlist  if the link is part of a playlist, get the whole playlist
              instead of just the one song
  -h          this message

Needs yt-dlp. Install it with one of:

  macOS          brew install yt-dlp
  Debian/Ubuntu  sudo apt install yt-dlp
  Fedora         sudo dnf install yt-dlp
  anywhere       pipx install yt-dlp     (or: python3 -m pip install --user yt-dlp)
EOF
}

# Options first, then the URLs — sh has no arrays, so the URLs are simply
# whatever is left in "$@" once the loop stops, which keeps their quoting
# intact without any shuffling.
while [ $# -gt 0 ]; do
  case $1 in
    -h|--help) usage; exit 0 ;;
    -o|--out)
      [ $# -ge 2 ] || { echo "music-get: -o needs a folder after it" >&2; exit 2; }
      out_dir=$2
      shift 2
      ;;
    --playlist) playlist=--yes-playlist; shift ;;
    --) shift; break ;;
    -*) echo "music-get: don't know the option $1 — try -h" >&2; exit 2 ;;
    *) break ;;
  esac
done

if [ $# -eq 0 ]; then
  usage >&2
  exit 2
fi

# Anything option-shaped down here came after a URL, where it is ignored rather
# than obeyed. Say so instead of handing it to yt-dlp as if it were a link.
for arg do
  case $arg in
    -*) echo "music-get: put $arg before the links, not after" >&2; exit 2 ;;
  esac
done

if ! command -v yt-dlp >/dev/null 2>&1; then
  echo "music-get: yt-dlp isn't installed, and it's the part that does the work." >&2
  echo >&2
  case $(uname -s) in
    Darwin) echo "  Install it with:  brew install yt-dlp" >&2 ;;
    Linux)
      if   [ -f /etc/debian_version ]; then echo "  Install it with:  sudo apt install yt-dlp" >&2
      elif [ -f /etc/fedora-release ]; then echo "  Install it with:  sudo dnf install yt-dlp" >&2
      else echo "  Install it with your package manager, or:  pipx install yt-dlp" >&2
      fi
      ;;
    *) echo "  Install it with:  pipx install yt-dlp" >&2 ;;
  esac
  exit 127
fi

mkdir -p "$out_dir"

# yt-dlp writes the name of every file it settles on into this list, which is
# how the run is checked below. It goes to a file rather than to the screen so
# that the download progress still scrolls past live.
saved=$(mktemp) || { echo "music-get: couldn't make a temporary file" >&2; exit 1; }
trap 'rm -f "$saved"' EXIT HUP INT TERM

count() { wc -l < "$saved" | tr -d ' '; }

# A link that isn't the video it appears to be — a shortened one that redirects,
# most often — gets resolved by yt-dlp's catch-all handler, and that can land on
# a YouTube *feed*, which it will then happily treat as a playlist. Asking for
# one song has to mean at most one song, so cap it unless a playlist was the
# actual request.
limit=
[ "$playlist" = --no-playlist ] && limit='--playlist-items 1'

# Whatever audio-only stream YouTube rates best, taken as it is. That is
# usually WebM/Opus, which Chrome and Firefox decode happily and which sounds
# better than the m4a alternative at the same bitrate. Safari's support for it
# is late and patchy, so if this ever needs to work there, ask for m4a instead
# with 'bestaudio[ext=m4a]/bestaudio' — still no conversion, just the other
# stream of the two YouTube already publishes.
status=0
for url do
  before=$(count)
  yt-dlp \
    --format bestaudio \
    --no-overwrites \
    $playlist $limit \
    --output "$out_dir/%(title)s.%(ext)s" \
    --print-to-file "after_move:%(filepath)s" "$saved" \
    "$url" || status=$?

  # yt-dlp can finish quietly having saved nothing at all — the feed case above
  # ends that way, reporting success over zero items. Silence must not read as
  # "done", so the run is judged on files, not on the exit code.
  if [ "$(count)" -eq "$before" ]; then
    echo "music-get: no sound came back for $url" >&2
    status=1
  fi
done

if [ -s "$saved" ]; then
  echo
  echo "Ready to open in the editor:"
  sed 's/^/  /' "$saved"
fi

if [ "$status" -ne 0 ]; then
  echo >&2
  echo "music-get: that didn't go cleanly. Check the link opens in a browser." >&2
  echo "Failing that, YouTube changes things often and yt-dlp has to keep up," >&2
  echo "so the next thing to try is updating it:" >&2
  echo >&2
  echo "  yt-dlp -U        (or reinstall it the way you installed it)" >&2
  exit "$status"
fi
