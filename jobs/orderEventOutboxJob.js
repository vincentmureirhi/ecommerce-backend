'use strict';

const { processOrderEventOutboxBatch } = require('../services/orderEventOutboxService');

async function processQueuedOrderEvents() {
  return processOrderEventOutboxBatch({
    limit: Number(process.env.ORDER_EVENT_OUTBOX_BATCH_SIZE || 50),
  });
}

module.exports = {
  processQueuedOrderEvents,
};