import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { Database } from "../src/db";

const config = loadConfig();
export default createApp(config, new Database(config.databaseUrl));
