'use strict';

const { processSmsOutboxBatch } = require('../services/smsService');

async function processQueuedSmsNotifications() {
  return processSmsOutboxBatch({
    limit: Number(process.env.SMS_BATCH_SIZE || 10),
  });
}

module.exports = {
  processQueuedSmsNotifications,
};
