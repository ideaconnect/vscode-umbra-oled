# Changelog

## 0.1.2

- Published on the Visual Studio Marketplace as `IDCTpl.umbra-oled-theme`.
- Added an extension icon and a black Marketplace banner.
- Added the IDCT logo to the README.
- CI publishes tagged releases to the Marketplace with Trusted Publishing,
  after a maintainer approves the run.
- The validator checks the icon (PNG, at least 128x128) and the banner color.

## 0.1.1

- Added screenshots to the README.
- Added install instructions for the release `.vsix`.
- The packaged extension no longer includes the screenshots folder.

## 0.1.0

- First release: true-black OLED theme with warm, low-glare syntax colors.
- Validator for the manifest, theme structure, VS Code color IDs and the
  OLED/readability rules.
- CI: validation against the latest stable VS Code, packaging, and gitleaks
  secret scan.
