@echo off
rem Get the sound out of a YouTube link, ready to open in the editor.
rem
rem   music-get.cmd "https://www.youtube.com/watch?v=..."
rem   music-get.cmd -o "%USERPROFILE%\Music\skate" URL URL URL
rem
rem This is a thin wrapper around yt-dlp, which does all the real work. It saves
rem the audio exactly as it already exists on the other end — nothing is
rem converted and nothing is re-encoded, so no quality is thrown away before you
rem have even started cutting.
rem
rem It does ask yt-dlp to write the title, artist and so on into the file, which
rem saves typing them onto an entry form later and is what the editor reads to
rem name a song. That step wants ffmpeg, but it only writes tags: the audio
rem comes out byte for byte the same. Without ffmpeg yt-dlp says so and still
rem saves the music, untagged.
rem
rem The Mac and Linux equivalent is music-get.sh next to this file. Keep the two
rem in step: same options, same defaults, same messages.

setlocal enabledelayedexpansion

set "OUT_DIR=."
set "PLAYLIST=--no-playlist"
set /a NURLS=0

:parse
if "%~1"=="" goto parsed
if /i "%~1"=="-h"         goto usage
if /i "%~1"=="--help"     goto usage
if /i "%~1"=="/?"         goto usage
if /i "%~1"=="--playlist" ( set "PLAYLIST=--yes-playlist" & shift & goto parse )
if /i "%~1"=="-o"         goto setout
if /i "%~1"=="--out"      goto setout
rem The links go into numbered variables rather than one space-separated list,
rem because the obvious `for %%U in (%LIST%)` would treat each one as a filename
rem pattern — and a YouTube link contains a ?, which is a wildcard. A pattern
rem matching no file yields no iterations at all, so the loop would quietly do
rem nothing and report success.
set /a NURLS+=1
set "URL_!NURLS!=%~1"
shift
goto parse

:setout
if "%~2"=="" (
  echo music-get: -o needs a folder after it >&2
  exit /b 2
)
set "OUT_DIR=%~2"
shift
shift
goto parse

:parsed
if %NURLS% equ 0 goto nothing_to_do

where yt-dlp >nul 2>nul
if errorlevel 1 (
  echo music-get: yt-dlp isn't installed, and it's the part that does the work. >&2
  echo. >&2
  echo   Install it with:  winget install yt-dlp.yt-dlp >&2
  echo   or:               pipx install yt-dlp >&2
  exit /b 127
)

if not exist "%OUT_DIR%" mkdir "%OUT_DIR%"

rem Build yt-dlp's filename templates out here rather than inside the loop
rem below: in a batch file %% means a literal %, but within a FOR body it is
rem also how the loop variable is spelled, and there is no reason to make the
rem parser decide which one %%(title)s is.
set "TEMPLATE=%OUT_DIR%\%%(title)s.%%(ext)s"
set "PRINTED=after_move:%%(filepath)s"

rem A link that isn't the video it appears to be — a shortened one that
rem redirects, most often — gets resolved by yt-dlp's catch-all handler, and
rem that can land on a YouTube *feed*, which it will then happily treat as a
rem playlist. Asking for one song has to mean at most one song, so cap it
rem unless a playlist was the actual request.
set "LIMIT="
if "%PLAYLIST%"=="--no-playlist" set "LIMIT=--playlist-items 1"

rem yt-dlp writes the name of every file it settles on into this list, which is
rem how the run is checked below. It goes to a file rather than to the screen so
rem that the download progress still scrolls past live.
set "LIST=%TEMP%\music-get-%RANDOM%%RANDOM%.txt"
type nul > "%LIST%"

rem Whatever audio-only stream YouTube rates best, taken as it is. That is
rem usually WebM/Opus, which Chrome and Firefox decode happily and which sounds
rem better than the m4a alternative at the same bitrate.
set "FAILED="
for /l %%I in (1,1,%NURLS%) do (
  set "URL=!URL_%%I!"
  call :count BEFORE
  yt-dlp --format bestaudio --embed-metadata --no-overwrites %PLAYLIST% %LIMIT% --output "!TEMPLATE!" --print-to-file "!PRINTED!" "!LIST!" "!URL!"
  if errorlevel 1 set "FAILED=1"
  call :count AFTER
  rem yt-dlp can finish quietly having saved nothing at all — the feed case
  rem above ends that way, reporting success over zero items. Silence must not
  rem read as "done", so the run is judged on files, not on the exit code.
  if !AFTER! equ !BEFORE! (
    echo music-get: no sound came back for !URL! >&2
    set "FAILED=1"
  )
)

for %%S in ("%LIST%") do if %%~zS gtr 0 (
  echo.
  echo Ready to open in the editor:
  for /f "usebackq delims=" %%F in ("%LIST%") do echo   %%F
)
del "%LIST%" 2>nul

if defined FAILED (
  echo. >&2
  echo music-get: that didn't go cleanly. Check the link opens in a browser. >&2
  echo Failing that, YouTube changes things often and yt-dlp has to keep up, >&2
  echo so the next thing to try is updating it: >&2
  echo. >&2
  echo   yt-dlp -U        ^(or reinstall it the way you installed it^) >&2
  exit /b 1
)
exit /b 0

rem Line count of the list so far, into the variable named by the argument.
:count
for /f %%N in ('find /c /v "" ^< "%LIST%"') do set "%~1=%%N"
goto :eof

rem Asking for the help is a success; being given nothing to do is not, and the
rem message goes to stderr in that case so it doesn't land in a pipe.
:usage
call :help
exit /b 0

:nothing_to_do
call :help >&2
exit /b 2

:help
echo Get the sound out of a YouTube link.
echo.
echo   music-get.cmd [options] URL [URL ...]
echo.
echo   -o DIR      where to put the files ^(default: here^)
echo   --playlist  if the link is part of a playlist, get the whole playlist
echo               instead of just the one song
echo   -h          this message
echo.
echo Needs yt-dlp. Install it with one of:
echo.
echo   winget install yt-dlp.yt-dlp
echo   pipx install yt-dlp
goto :eof
