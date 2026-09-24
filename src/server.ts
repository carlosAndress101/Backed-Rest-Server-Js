import type { Server } from 'node:http';

import type { Express } from 'express';

import { createApp } from './app';
import { loadConfig } from './config';
import { createLogger, type Logger } from './core/logger';
import { connectDatabase, disconnectDatabase } from './database/connection';

const SHUTDOWN_TIMEOUT_MS = 10_000;

function listen(app: Express, port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    // Express 5 passes listen errors (EADDRINUSE) to this callback instead of emitting them.
    const server = app.listen(port, (error) => (error ? reject(error) : resolve(server)));
  });
}

function onShutdownSignal(server: Server, logger: Logger): void {
  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    setTimeout(() => {
      logger.fatal('graceful shutdown timed out');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS).unref();
    // Stops accepting connections, closes idle keep-alive sockets, waits for in-flight requests.
    server.close((closeError) => {
      disconnectDatabase().then(
        () => process.exit(closeError ? 1 : 0),
        (dbError: unknown) => {
          logger.error({ err: dbError }, 'failed to close the database connection');
          process.exit(1);
        },
      );
    });
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

async function main(): Promise<void> {
  const config = loadConfig(); // fail fast on an invalid environment (exit 1)
  const logger = createLogger(config);
  const crash = (kind: string) => (reason: unknown) => {
    logger.fatal({ err: reason }, kind);
    process.exit(1);
  };
  process.on('unhandledRejection', crash('unhandled rejection'));
  process.on('uncaughtException', crash('uncaught exception'));
  if (config.env === 'production' && config.cors.origins === '*') {
    logger.warn('CORS_ORIGINS is not set: every origin may call this API');
  }
  // The database before any traffic (C3 / REL-03). Production builds indexes with `pnpm migrate`, not on boot (§10.1).
  await connectDatabase(config.mongoUri, { autoIndex: config.env !== 'production' });
  logger.info('database connected');
  const server = await listen(createApp({ config, logger }), config.port);
  logger.info({ port: config.port }, 'server listening');
  onShutdownSignal(server, logger);
}

main().catch((error: unknown) => {
  // Boot failed, possibly before the logger existed (invalid config): plain stderr, non-zero exit.
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});
