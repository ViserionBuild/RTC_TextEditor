import { configFromEnv } from './config';
import { buildRelay } from './server';

const config = configFromEnv();
const { app } = await buildRelay(config);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, 'shutting down');
    void app.close().then(() => process.exit(0));
  });
}

await app.listen({ port: config.port, host: config.host });
