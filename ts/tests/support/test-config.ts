/**
 * Shared test configuration — imported by both testcontainers and docker-compose tests.
 *
 * Single source of truth for OC version, mock model, and test paths.
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const OC_VERSION = "2026.6.8";
export const MOCK_MODEL = "test/model";
export const MOCK_API_KEY = "test-key";
export const MOCK_BASE_URL = "http://127.0.0.1:9999/v1";

// Paths
export const TS_DIR = path.resolve(__dirname, "../..");
export const REPO_ROOT = path.resolve(TS_DIR, "..");
export const PLUGIN_DIR = path.resolve(TS_DIR, "src/plugins");
export const SHARED_DIR = path.resolve(TS_DIR, "src/plugins/shared");
export const OC_SOURCE = path.resolve(REPO_ROOT, "oc-source");
export const DOCKERFILE = path.resolve(REPO_ROOT, "docker/Dockerfile");
export const TEST_OPENCLAW_CONFIG = path.resolve(REPO_ROOT, "docker/test-openclaw.json");
