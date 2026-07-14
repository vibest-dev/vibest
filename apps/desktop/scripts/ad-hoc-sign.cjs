const { execFileSync } = require("node:child_process");
const path = require("node:path");

/**
 * Ad-hoc sign the .app after packaging.
 *
 * There is no Apple Developer identity here, so electron-builder skips signing
 * (`identity: null`). But it has already renamed the Electron binary and added
 * our Resources, which invalidates the signature the prebuilt Electron shipped
 * with — and macOS on Apple Silicon refuses to launch a bundle whose signature
 * does not verify. It dies instantly, with no output and no crash report.
 *
 * An ad-hoc signature (`--sign -`) satisfies the loader. It grants no trust and
 * is not a substitute for real signing before distribution.
 */
exports.default = async function adHocSign(context) {
  if (context.electronPlatformName !== "darwin") return;

  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);

  execFileSync("codesign", ["--force", "--deep", "--sign", "-", appPath], {
    stdio: "inherit",
  });
};
