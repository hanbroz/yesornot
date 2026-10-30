'use strict';

module.exports = {
  appId: 'ai.typesafe.yesornot',
  productName: 'YES or NO',
  directories: { output: 'dist', buildResources: 'assets' },
  asar: true,
  npmRebuild: false,
  // Production dependencies and package.json are added by electron-builder.
  // Everything else comes from this explicit runtime allowlist.
  files: [
    'main.cjs', 'preload.cjs', 'app.js', 'index.html', 'styles.css',
    'build-info.json', 'fonts/**/*', 'assets/app-icon.png', 'assets/app-icon.ico',
    'services/*.cjs', 'services/*.py', 'scripts/login.ps1',
    '!**/.env', '!**/.env.*', '!**/*-key.bin', '!**/decisions.json',
    '!**/.omx/**', '!**/.codex/**', '!**/.git/**', '!**/tests/**',
  ],
  publish: [{ provider: 'github', owner: 'hanbroz', repo: 'yesornot', releaseType: 'release' }],
  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    icon: 'assets/app-icon.ico',
    executableName: 'YESORNOT',
    artifactName: 'YESORNOT-Setup-${version}.${ext}',
    // This release has no Authenticode certificate. The updater still verifies
    // the release feed's SHA-512 over HTTPS; publisher identity is not signed.
    verifyUpdateCodeSignature: false,
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowElevation: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: 'YES or NO',
    runAfterFinish: false,
    deleteAppDataOnUninstall: false,
    differentialPackage: true,
    installerIcon: 'assets/app-icon.ico',
    uninstallerIcon: 'assets/app-icon.ico',
  },
};
