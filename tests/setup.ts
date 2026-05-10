// Jest setup file
// Initialize test environment

process.env.PRIVATE_KEY = 'test_private_key_base58_encoded';
process.env.RPC_URL = 'https://api.devnet.solana.com';
process.env.HELIUS_API_KEY = 'test_helius_key';
process.env.TOTAL_CAPITAL_USD = '200';
process.env.LOG_LEVEL = 'error'; // Minimize noise in tests

import fs from 'fs';
import path from 'path';

// Ensure data files exist with valid JSON before tests
const dataDir = path.resolve('./src/data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const defaultBotState = {
  overallState: 'RUNNING',
  consecutiveLossCount: 0,
  totalFeesClaimedUsd: '0',
  totalGasSpentUsd: '0',
  totalIlRealizedUsd: '0',
  feeReserveUsd: '0',
  totalCapital: '200',
  pair1Allocation: '90',
  pair2Allocation: '90',
  gasReserve: '20',
  circuitBreakerTriggeredAt: null,
  pausedAt: null,
  pauseReason: null,
  lastPositionClosedAt: null,
};

const files = ['positions.json', 'bot_state.json', 'blacklist.json', 'scan_cache.json'];
for (const file of files) {
  const filePath = path.join(dataDir, file);
  if (!fs.existsSync(filePath) || fs.readFileSync(filePath, 'utf-8').trim() === '') {
    if (file === 'bot_state.json') {
      fs.writeFileSync(filePath, JSON.stringify(defaultBotState, null, 2));
    } else if (file === 'scan_cache.json') {
      fs.writeFileSync(filePath, JSON.stringify({
        lastScanTime: new Date().toISOString(),
        thresholdUsed: 1.0,
        topPairs: [],
      }, null, 2));
    } else {
      fs.writeFileSync(filePath, '[]');
    }
  }
}

// Mock global fetch to prevent real API calls during tests
global.fetch = jest.fn(() =>
  Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ data: {} }),
  } as unknown as Response)
) as jest.Mock;
