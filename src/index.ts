import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { AppStatusService, AppConfig } from "./services/app-status-service";

dotenv.config();

async function main() {
  try {
    if (
      !process.env.APP_STORE_CONNECT_KEY_ID ||
      !process.env.APP_STORE_CONNECT_ISSUER_ID ||
      !process.env.APP_STORE_CONNECT_PRIVATE_KEY
    ) {
      throw new Error("App Store Connect API not exist");
    }

    const appsConfigPath = path.join(process.cwd(), "apps.json");
    if (!fs.existsSync(appsConfigPath)) {
      throw new Error(`apps.json not exist: ${appsConfigPath}`);
    }

    const appsConfig: AppConfig[] = JSON.parse(fs.readFileSync(appsConfigPath, "utf-8"));

    if (!Array.isArray(appsConfig) || appsConfig.length === 0) {
      throw new Error("apps.json is empty or invalid.");
    }

    console.log(`${appsConfig.length} apps loaded from apps.json.`);

    const appStatusService = new AppStatusService(appsConfig);

    console.log("Checking app statuses...");
    await appStatusService.checkAppStatus();

    try {
      await appStatusService.checkAppStatus();
    } catch (error) {
      console.error("Error checking app status:", error);
    }
  } catch (error) {
    console.error("Error initializing app:", error);
    process.exit(1);
  }
}

main().catch(console.error);
