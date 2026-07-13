#!/usr/bin/env bash
# ------------------------------------------------------
# Dev-mode macOS file association for `.fcap` / `.fovea` recordings.
# Builds `~/Applications/FoveaCam Dev.app` — an AppleScript droplet that
# forwards opened files to the RUNNING app over its userData Unix socket (no
# second Electron), cold-starting the dev binary only when nothing is listening.
# Idempotent: re-run to rebuild. See docs/dev/fcap-file-association.md.
# ------------------------------------------------------
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
APP="$HOME/Applications/FoveaCam Dev.app"
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"

echo "Building $APP (repo: $REPO)"
rm -rf "$APP"
mkdir -p "$HOME/Applications"

# --- AppleScript droplet: forward opened files (or a bare launch) to forward.sh
TMP_SCPT="$(mktemp -t fovea-dev-shim).applescript"
cat >"$TMP_SCPT" <<'APPLESCRIPT'
on run
	do shell script (quoted form of (POSIX path of (path to me)) & "Contents/Resources/forward.sh")
end run

on open theFiles
	set args to ""
	repeat with f in theFiles
		set args to args & " " & quoted form of POSIX path of f
	end repeat
	do shell script (quoted form of (POSIX path of (path to me)) & "Contents/Resources/forward.sh") & args
end open
APPLESCRIPT
osacompile -o "$APP" "$TMP_SCPT"
rm -f "$TMP_SCPT"

# --- Forwarder: notify a running instance over the socket, else cold-start.
# __REPO__ is substituted with the absolute repo path at install time.
FORWARD="$APP/Contents/Resources/forward.sh"
cat >"$FORWARD" <<'FORWARD_SH'
#!/usr/bin/env bash
set -euo pipefail
REPO="__REPO__"
SOCK="$HOME/Library/Application Support/fovea-cam-app/open-file.sock"

if [ -S "$SOCK" ]; then
  if printf '%s\n' "$@" | /usr/bin/nc -U -w 2 "$SOCK"; then
    exit 0
  fi
fi

nohup "$REPO/app/node_modules/.bin/electron" "$REPO/app" "$@" >/dev/null 2>&1 &
FORWARD_SH
# Bake the repo path into the forwarder (placeholder → absolute path).
/usr/bin/sed -i '' "s|__REPO__|$REPO|g" "$FORWARD"
chmod +x "$FORWARD"

# --- Info.plist: identity, document types, exported UTIs.
PLIST="$APP/Contents/Info.plist"
PB="/usr/libexec/PlistBuddy"

"$PB" -c "Set :CFBundleIdentifier app.foveacam.dev-shim" "$PLIST" 2>/dev/null \
  || "$PB" -c "Add :CFBundleIdentifier string app.foveacam.dev-shim" "$PLIST"
"$PB" -c "Set :CFBundleName FoveaCam Dev" "$PLIST" 2>/dev/null \
  || "$PB" -c "Add :CFBundleName string FoveaCam Dev" "$PLIST"

# CFBundleDocumentTypes: .fcap (Owner) + .fovea (Alternate, read-only legacy).
"$PB" -c "Delete :CFBundleDocumentTypes" "$PLIST" 2>/dev/null || true
"$PB" -c "Add :CFBundleDocumentTypes array" "$PLIST"

"$PB" -c "Add :CFBundleDocumentTypes:0 dict" "$PLIST"
"$PB" -c "Add :CFBundleDocumentTypes:0:CFBundleTypeName string FoveaCam Recording" "$PLIST"
"$PB" -c "Add :CFBundleDocumentTypes:0:CFBundleTypeRole string Viewer" "$PLIST"
"$PB" -c "Add :CFBundleDocumentTypes:0:LSHandlerRank string Owner" "$PLIST"
"$PB" -c "Add :CFBundleDocumentTypes:0:LSItemContentTypes array" "$PLIST"
"$PB" -c "Add :CFBundleDocumentTypes:0:LSItemContentTypes:0 string app.foveacam.fcap" "$PLIST"

"$PB" -c "Add :CFBundleDocumentTypes:1 dict" "$PLIST"
"$PB" -c "Add :CFBundleDocumentTypes:1:CFBundleTypeName string FoveaCam Recording (legacy)" "$PLIST"
"$PB" -c "Add :CFBundleDocumentTypes:1:CFBundleTypeRole string Viewer" "$PLIST"
"$PB" -c "Add :CFBundleDocumentTypes:1:LSHandlerRank string Alternate" "$PLIST"
"$PB" -c "Add :CFBundleDocumentTypes:1:LSItemContentTypes array" "$PLIST"
"$PB" -c "Add :CFBundleDocumentTypes:1:LSItemContentTypes:0 string app.foveacam.fovea" "$PLIST"

# UTExportedTypeDeclarations: declare both UTIs (conform to public.data).
"$PB" -c "Delete :UTExportedTypeDeclarations" "$PLIST" 2>/dev/null || true
"$PB" -c "Add :UTExportedTypeDeclarations array" "$PLIST"

add_uti() {
  local idx="$1" uti="$2" ext="$3"
  "$PB" -c "Add :UTExportedTypeDeclarations:$idx dict" "$PLIST"
  "$PB" -c "Add :UTExportedTypeDeclarations:$idx:UTTypeIdentifier string $uti" "$PLIST"
  "$PB" -c "Add :UTExportedTypeDeclarations:$idx:UTTypeDescription string FoveaCam Recording" "$PLIST"
  "$PB" -c "Add :UTExportedTypeDeclarations:$idx:UTTypeConformsTo array" "$PLIST"
  "$PB" -c "Add :UTExportedTypeDeclarations:$idx:UTTypeConformsTo:0 string public.data" "$PLIST"
  "$PB" -c "Add :UTExportedTypeDeclarations:$idx:UTTypeTagSpecification dict" "$PLIST"
  "$PB" -c "Add :UTExportedTypeDeclarations:$idx:UTTypeTagSpecification:public.filename-extension array" "$PLIST"
  "$PB" -c "Add :UTExportedTypeDeclarations:$idx:UTTypeTagSpecification:public.filename-extension:0 string $ext" "$PLIST"
}
add_uti 0 app.foveacam.fcap fcap
add_uti 1 app.foveacam.fovea fovea

# --- Register with LaunchServices.
"$LSREGISTER" -f "$APP"

# --- Set as the default handler (duti if available, else instruct the user).
if command -v duti >/dev/null 2>&1; then
  duti -s app.foveacam.dev-shim app.foveacam.fcap all
  duti -s app.foveacam.dev-shim app.foveacam.fovea all
  echo "Default handler set via duti."
else
  echo "duti not found. To finish: Finder → Get Info on a .fcap → Open with → FoveaCam Dev → Change All."
fi

echo "Done. Double-click a .fcap or run: open -b app.foveacam.dev-shim <file>.fcap"
