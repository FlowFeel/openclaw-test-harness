import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Validates that a git patch file can be applied cleanly using patch-package dry-run.
 *
 * @param patchPath - Absolute path to the patch file.
 * @param targetPackageName - Package name to patch (e.g. 'openclaw' or a placeholder).
 * @param targetVersion - Package version.
 * @returns boolean - True if the patch applies cleanly.
 */
export function verifyPatchAppliesCleanly(params: {
  patchPath: string;
  targetPackageName: string;
  targetVersion: string;
}): boolean {
  const { patchPath, targetPackageName, targetVersion } = params;
  const tempDir = path.resolve(__dirname, "../../temp-patch-test");

  try {
    // 1. Create a isolated temp directory
    fs.mkdirSync(tempDir, { recursive: true });
    
    // Create a mock package.json
    fs.writeFileSync(
      path.join(tempDir, "package.json"),
      JSON.stringify({
        name: "temp-patch-test",
        private: true,
        dependencies: {
          [targetPackageName]: targetVersion,
        },
      }, null, 2)
    );

    // 2. Install dependencies locally in the temp folder
    // Using --no-audit and --no-fund for speed
    execSync("npm install --no-audit --no-fund", { cwd: tempDir, stdio: "ignore" });

    // 3. Create the patches/ directory structure matching patch-package
    const patchesDir = path.join(tempDir, "patches");
    fs.mkdirSync(patchesDir, { recursive: true });

    // Copy our patch file to the patches folder named precisely as patch-package expects
    const destinationPatchName = `${targetPackageName}+${targetVersion}.patch`;
    fs.copyFileSync(patchPath, path.join(patchesDir, destinationPatchName));

    // 4. Execute patch-package to dry-run/apply the patch
    execSync("npx patch-package", { cwd: tempDir, stdio: "inherit" });

    return true;
  } catch (error) {
    console.error("Patch validation execution failed:", error);
    return false;
  } finally {
    // Clean up temporary workspace
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (cleanupError) {
      console.warn("Temporary patch directory cleanup failed:", cleanupError);
    }
  }
}
