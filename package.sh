#!/bin/sh
# Builds "Book Shelf.app" (Apple Silicon) and installs it into ~/Applications.
# It is built in a temporary folder because folders such as Desktop carry extra Finder metadata
# that stops macOS from signing the app.
set -e
BUILD=$(mktemp -d)
npx electron-packager . "Book Shelf" \
  --platform=darwin --arch=arm64 \
  --icon=assets/icons/icon_app.icns \
  --out="$BUILD" --overwrite \
  --ignore="^/README.md$" --ignore="^/package.sh$" --ignore="^/.gitignore$" \
  --ignore="icon_app.png" --ignore="icon_app_large.png" --ignore="icon_app.icns"
APP="$BUILD/Book Shelf-darwin-arm64/Book Shelf.app"
xattr -cr "$APP"
codesign --force --deep --sign - "$APP"          # a free local signature, enough to run on this Mac
mkdir -p "$HOME/Applications"
rm -rf "$HOME/Applications/Book Shelf.app"
ditto --noextattr --noqtn "$APP" "$HOME/Applications/Book Shelf.app"
rm -rf "$BUILD"
codesign --verify --deep --strict "$HOME/Applications/Book Shelf.app"
echo "Installed: $HOME/Applications/Book Shelf.app"
