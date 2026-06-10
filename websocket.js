const { Server } = require('socket.io');

let io;
const connectedClients = new Map();

function getAllowedSocketOrigins() {
  const defaults = [
    'http://localhost:5173',
    'http://localhost:5174',
    'http://localhost:3000',
    'http://127.0.0.1:5173',
    'http://127.0.0.1:5174',
    'https://ecommerce-admin-seven-ashy.vercel.app',
    'https://xpose-distributors.vercel.app',
  ];

  const envOrigins = [
    process.env.CORS_ORIGINS,
    process.env.ADMIN_URL,
    process.env.STOREFRONT_URL,
    process.env.FRONTEND_URL,
  ]
    .filter(Boolean)
    .flatMap((value) => String(value).split(','))
    .map((origin) => origin.trim().replace(/\/$/, ''))
    .filter(Boolean);

  return [...new Set([...defaults, ...envOrigins])];
}

function initializeWebSocket(httpServer) {
  io = new Server(httpServer, {
    cors: {
      origin: getAllowedSocketOrigins(),
      methods: ['GET', 'POST'],
      credentials: true,
    },
    transports: ['websocket', 'polling'],
  });

  io.on('connection', (socket) => {
    console.log(`✅ Client connected: ${socket.id}`);
    connectedClients.set(socket.id, socket);

    // Listen for dashboard subscriptions
    socket.on('subscribe:payments', () => {
      socket.join('payments-room');
      console.log(`📊 Client subscribed to payments: ${socket.id}`);
      socket.emit('subscription:confirmed', { type: 'payments' });
    });

    socket.on('subscribe:alerts', () => {
      socket.join('alerts-room');
      console.log(`🚨 Client subscribed to alerts: ${socket.id}`);
      socket.emit('subscription:confirmed', { type: 'alerts' });
    });

    socket.on('disconnect', () => {
      console.log(`❌ Client disconnected: ${socket.id}`);
      connectedClients.delete(socket.id);
    });

    socket.on('error', (err) => {
      console.error(`🔴 Socket error (${socket.id}):`, err);
    });
  });

  console.log('✅ WebSocket server initialized');
  return io;
}

// Broadcast functions
function broadcastPaymentStatusChange(paymentData) {
  if (io) {
    io.to('payments-room').emit('payment:updated', {
      type: 'payment_status_changed',
      timestamp: new Date(),
      data: paymentData,
    });
    console.log(`📤 Broadcast payment update: Payment #${paymentData.id}`);
  }
}

function broadcastAlert(alertData) {
  if (io) {
    io.to('alerts-room').emit('alert:new', {
      type: 'payment_alert',
      timestamp: new Date(),
      data: alertData,
    });
    console.log(`📤 Broadcast alert: ${alertData.title}`);
  }
}

function broadcastPaymentFailed(paymentData) {
  if (io) {
    io.to('payments-room').emit('payment:failed', {
      type: 'payment_failed',
      timestamp: new Date(),
      data: paymentData,
    });
    
    // Also send as alert
    broadcastAlert({
      title: `Payment Failed - Order #${paymentData.order_id}`,
      severity: 'critical',
      message: `Payment of KES ${paymentData.amount} failed: ${paymentData.result_desc}`,
      payment_id: paymentData.id,
      order_id: paymentData.order_id,
    });
  }
}

function broadcastPaymentCompleted(paymentData) {
  if (io) {
    io.to('payments-room').emit('payment:completed', {
      type: 'payment_completed',
      timestamp: new Date(),
      data: paymentData,
    });

    // Send success notification
    broadcastAlert({
      title: `Payment Successful - Order #${paymentData.order_id}`,
      severity: 'info',
      message: `KES ${paymentData.amount} received (Receipt: ${paymentData.mpesa_receipt})`,
      payment_id: paymentData.id,
      order_id: paymentData.order_id,
    });
  }
}

function broadcastPaymentPending(paymentData) {
  if (io) {
    io.to('payments-room').emit('payment:pending', {
      type: 'payment_pending',
      timestamp: new Date(),
      data: paymentData,
    });
  }
}

function getConnectedClientsCount() {
  return connectedClients.size;
}

module.exports = {
  initializeWebSocket,
  broadcastPaymentStatusChange,
  broadcastAlert,
  broadcastPaymentFailed,
  broadcastPaymentCompleted,
  broadcastPaymentPending,
  getConnectedClientsCount,
};
