# Changelog

## 0.1.3

- README: GitHub Sponsors and Buy Me a Coffee badges, and a "Free software runs
  on coffee" support bar at the end.
- Added `.github/FUNDING.yml`, so GitHub shows a **Sponsor** button on the repository.
- VS Code shows a **Sponsor** button on the extension page (`sponsor` in `package.json`).

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
