#!/usr/bin/env node

/**
 * Meteora DLMM LP Automation Bot
 *
 * Entry point. Initializes and starts the bot.
 *
 * Usage:
 *   npm start              # Start the bot
 *   npm run dev            # Start in development mode
 *   npm test               # Run tests
 *
 * Environment:
 *   Copy .env.example to .env and fill in your values.
 */

import { startBot, gracefulShutdown } from './bot';
import { logCrit } from './utils/logger';

async function main(): Promise<void> {
  try {
    await startBot();
  } catch (error) {
    logCrit('Fatal error during bot startup', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    process.exit(1);
  }
}

// Catch unhandled errors
process.on('uncaughtException', (error) => {
  logCrit('Uncaught exception', {
    error: error.message,
    stack: error.stack,
  });
  gracefulShutdown('uncaughtException').catch(() => process.exit(1));
});

process.on('unhandledRejection', (reason) => {
  logCrit('Unhandled rejection', { reason: String(reason) });
  gracefulShutdown('unhandledRejection').catch(() => process.exit(1));
});

main();
