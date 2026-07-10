# Orange Fuji

<p align="center">
  <img src="src/assets/icons/macos/256x256.png" alt="Orange Fuji icon" width="128" height="128" />
</p>

<p align="center">
  <strong>Capture, annotate, share.</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/github/downloads/erikmartinjordan/orange-fuji/total?label=Total%20downloads&style=flat-square" alt="Total downloads" />
</p>

Orange Fuji is a minimal screen capture and annotation app for Windows, Linux, and macOS.

## Download

[Download the latest release](../../releases/latest)

Recommended launch targets:

- Windows: portable EXE
- Linux: AppImage
- macOS: Developer ID signed and notarized DMG/ZIP when Apple signing secrets are configured in GitHub Actions

> Windows may show a SmartScreen warning on first launch because releases are not yet signed. macOS CI builds fall back to ad-hoc signing only when Apple signing or notarization secrets are missing.

### macOS signing and notarization

The GitHub Actions build signs and notarizes macOS artifacts when these repository secrets are configured:

- `MAC_CSC_LINK`: base64-encoded `.p12` Developer ID Application certificate exported from Keychain Access.
- `MAC_CSC_KEY_PASSWORD`: password for the exported `.p12` certificate.
- `APPLE_ID`: Apple Developer account email used for notarization.
- `APPLE_APP_SPECIFIC_PASSWORD`: app-specific password for that Apple ID.
- `APPLE_TEAM_ID`: 10-character Apple Developer Team ID.

Where to get each secret:

1. Create or download a `Developer ID Application` certificate in Apple Developer → Certificates, Identifiers & Profiles → Certificates. Use the Apple Developer account that owns the app's team.
2. Install the certificate on a Mac by opening the downloaded certificate file. In Keychain Access, export the `Developer ID Application` certificate together with its private key as a `.p12` file and choose a strong export password.
3. Convert that `.p12` file to base64 and paste the output into `MAC_CSC_LINK`:

   ```bash
   base64 -i DeveloperIDApplication.p12 | pbcopy
   ```

4. Use the `.p12` export password as `MAC_CSC_KEY_PASSWORD`.
5. Use your Apple Developer account email as `APPLE_ID`.
6. Generate an app-specific password for that Apple ID and use it as `APPLE_APP_SPECIFIC_PASSWORD`.
7. Copy the team's 10-character Team ID from Apple Developer membership details and use it as `APPLE_TEAM_ID`.
8. Add each value in GitHub → repository Settings → Secrets and variables → Actions → Repository secrets.

If any Apple notarization credential is missing, the macOS build remains ad-hoc signed so pull requests and local CI still produce test artifacts. Release builds intended for end users should verify that all five secrets are present before publishing.

## Features

- Capture a region, window, or display
- Annotate with shapes, arrows, text, highlight, and blur
- Undo, redo, zoom, and pan
- Save as PNG or copy to clipboard
- Pro tools: scrolling capture and screen recording

## Shortcuts

| Shortcut | Action |
| --- | --- |
| `Cmd/Ctrl+Shift+S` | Capture screen |
| `Cmd/Ctrl+O` | Open image |
| `Cmd/Ctrl+E` | Export PNG |
| `Cmd/Ctrl+C` | Copy to clipboard |
| `Cmd/Ctrl+Z` | Undo |
| `Cmd/Ctrl+Shift+Z` | Redo |
| `R`, `E`, `A`, `L`, `T`, `H`, `B`, `W` | Select annotation tools |
| `+` / `-` | Zoom in/out |
| `0` | Fit to window |

## Development

Requirements: Node.js 20+ and npm.

```bash
npm install
npm start
```

Build the app:

```bash
npm run build          # current platform
npm run build:desktop  # Windows and Linux launch artifacts
npm run build:win      # Windows portable EXE
npm run build:linux    # Linux AppImage
npm run build:mac      # macOS artifacts; notarized when Apple credentials are configured
npm run build:all      # macOS, Windows, and Linux
```

Builds are written to `dist/`.

## Release strategy

Orange Fuji uses Release Please with Conventional Commits for all official GitHub Releases. Pushes to `main` can build and upload CI artifacts, but they do not create official releases.

Use Conventional Commits for changes:

- `feat: add region presets`
- `fix: handle denied screen recording permission`
- `docs: update installation notes`
- `refactor: simplify capture state`

After commits are merged to `main`, Release Please opens or updates a release PR containing the next version bump and `CHANGELOG.md` changes. Merge that Release Please PR only when you are ready to publish officially; merging it creates the Git tag, GitHub Release, changelog update, and package version update. The release workflow then builds the desktop binaries and attaches them to that GitHub Release.

Before publishing a release:

- Build Windows portable EXE, Linux AppImage, and notarized macOS DMG/ZIP artifacts.
- Publish SHA-256 checksums for every artifact.
- Confirm macOS artifacts were Developer ID signed and notarized in GitHub Actions before marketing them as one-click downloads.
- Keep the GitHub release page as the only official binary download source.

## License

MIT
