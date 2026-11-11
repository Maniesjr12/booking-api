import { createApp } from './app';
import { loadConfig } from './config';
import { Database } from './db';

const config = loadConfig();
const db = new Database(config.databaseUrl);
const port = Number(process.env.PORT ?? 3000);

db.init()
  .then(() => {
    createApp(config, db).listen(port, () => {
      console.log(`booking-api listening on :${port}`);
    });
  })
  .catch((err) => {
    console.error('failed to start', err);
    process.exit(1);
  });
