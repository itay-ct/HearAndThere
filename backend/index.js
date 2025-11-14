const express = require('express');
const cors = require('cors');
const { createClient } = require('redis');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 4000;

// Prefer configuring this via the REDIS_URL env var in local/dev.
// Falls back to the URL you provided.
const REDIS_URL =
  process.env.REDIS_URL ||
  'redis://default:wNqKzQrXYYFugJzyqmzIGvo2HTYzYXIz@redis-18306.fcrce259.eu-central-1-3.ec2.cloud.redislabs.com:18306';

const redisClient = createClient({ url: REDIS_URL });

redisClient.on('error', (err) => {
  console.error('Redis Client Error', err);
});

async function start() {
  try {
    await redisClient.connect();
    console.log('Connected to Redis');
  } catch (err) {
    console.error('Failed to connect to Redis', err);
    process.exit(1);
  }

  app.use(cors());
  app.use(express.json());

  app.get('/health', async (req, res) => {
    try {
      await redisClient.ping();
      res.json({ status: 'ok' });
    } catch (err) {
      console.error('Health check failed', err);
      res.status(500).json({ status: 'redis-error' });
    }
  });

  app.post('/api/session', async (req, res) => {
    const { latitude, longitude, durationMinutes } = req.body || {};

    if (
      typeof latitude !== 'number' ||
      typeof longitude !== 'number' ||
      typeof durationMinutes !== 'number'
    ) {
      return res.status(400).json({
        error: 'Invalid payload. Expected numeric latitude, longitude, durationMinutes.',
      });
    }

    const sessionId = uuidv4();
    const key = `session:${sessionId}`;
    const createdAt = Date.now();

    try {
      await redisClient.hSet(key, {
        latitude: String(latitude),
        longitude: String(longitude),
        durationMinutes: String(durationMinutes),
        createdAt: String(createdAt),
      });

      res.json({ sessionId, status: 'saved' });
    } catch (err) {
      console.error('Error saving session to Redis', err);
      res.status(500).json({ error: 'Failed to save session' });
    }
  });

  const server = app.listen(PORT, () => {
    console.log(`API server listening on http://localhost:${PORT}`);
  });

  const shutdown = async () => {
    console.log('Shutting down API server...');
    try {
      await redisClient.quit();
    } catch (err) {
      console.error('Error closing Redis connection', err);
    }
    server.close(() => {
      process.exit(0);
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

start();

