'use strict';

const pool = require('../config/database');

// processing -> dispatched after this many hours without a manual update
const PROCESSING_TO_DISPATCHED_HOURS = 4;

// dispatched -> completed after this many hours without a manual update
const DISPATCHED_TO_COMPLETED_HOURS = 8;

/**
 * Auto-advance orders that have been sitting in an intermediate status too long.
 *
 * Safety guarantees:
 *  - Conditional WHERE ensures we only touch rows still in the expected prior status
 *    (prevents double-advancement if the job overlaps itself)
 *  - `status_changed_at` is used as the timing baseline, not `updated_at`, because
 *    payment and other unrelated updates can bump `updated_at`
 *  - Cancelled and completed orders are never touched
 *  - `status_changed_at` is always refreshed when automation changes a status so that
 *    subsequent job runs use the correct baseline
 *  - Idempotent: running the job multiple times produces the same end result
 */
async function autoProgressOrders() {
  const processingResult = await pool.query(
    `UPDATE orders
     SET order_status     = 'dispatched',
         status_changed_at = CURRENT_TIMESTAMP,
         updated_at        = CURRENT_TIMESTAMP
     WHERE order_status = 'processing'
       AND status_changed_at IS NOT NULL
       AND status_changed_at < NOW() - $1 * INTERVAL '1 hour'
     RETURNING id, order_number`,
    [PROCESSING_TO_DISPATCHED_HOURS]
  );

  if (processingResult.rows.length > 0) {
    console.log(
      `[ORDER-PROGRESSION] ✅ Moved ${processingResult.rows.length} order(s) processing -> dispatched`
    );
    processingResult.rows.forEach((o) =>
      console.log(`   📦 Order #${o.order_number} -> dispatched`)
    );
  }

  const dispatchedResult = await pool.query(
    `UPDATE orders
     SET order_status     = 'completed',
         status_changed_at = CURRENT_TIMESTAMP,
         updated_at        = CURRENT_TIMESTAMP
     WHERE order_status = 'dispatched'
       AND status_changed_at IS NOT NULL
       AND status_changed_at < NOW() - $1 * INTERVAL '1 hour'
     RETURNING id, order_number`,
    [DISPATCHED_TO_COMPLETED_HOURS]
  );

  if (dispatchedResult.rows.length > 0) {
    console.log(
      `[ORDER-PROGRESSION] ✅ Moved ${dispatchedResult.rows.length} order(s) dispatched -> completed`
    );
    dispatchedResult.rows.forEach((o) =>
      console.log(`   ✅ Order #${o.order_number} -> completed`)
    );
  }

  return {
    processingToDispatched: processingResult.rows.length,
    dispatchedToCompleted: dispatchedResult.rows.length,
  };
}

module.exports = { autoProgressOrders };
