const express = require("express");
const { createServer } = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
const server = createServer(app);

// Configure CORS for both Express and Socket.IO
const corsOptions = {
  origin:
    process.env.NODE_ENV === "production"
      ? [process.env.CLIENT_URL, process.env.FRONTEND_URL]
      : ["http://localhost:3000", "http://localhost:3001"],
  credentials: true,
  methods: ["GET", "POST"],
};

app.use(cors(corsOptions));

// Socket.IO configuration
const io = new Server(server, {
  cors: corsOptions,
  transports: ["websocket", "polling"], // Important for Render deployment
  pingTimeout: 60000,
  pingInterval: 25000,
  allowEIO3: true, // For compatibility
});

// Store active connections by pod
const podConnections = new Map();

// Health check endpoint (required for Render)
app.get("/health", (req, res) => {
  res.status(200).json({ status: "OK", timestamp: new Date().toISOString() });
});

// Basic route
app.get("/", (req, res) => {
  res.json({
    message: "Socket.IO server is running",
    timestamp: new Date().toISOString(),
  });
});

const PORT = process.env.PORT || 3002;

console.log(`Socket.IO server starting on port ${PORT}`);

io.on("connection", (socket) => {
  console.log(`Socket connected: ${socket.id}`);

  // Handle pod joining
  socket.on("join-pod", ({ podId, userId }) => {
    if (!podId || !userId) {
      console.log(`Socket ${socket.id}: Missing podId or userId`);
      socket.emit("error", { message: "Missing podId or userId" });
      return;
    }

    console.log(`Socket ${socket.id} joining pod: ${podId} as user: ${userId}`);

    // Store user info on socket
    socket.podId = podId;
    socket.userId = userId;

    // Join the pod room
    socket.join(podId);

    // Add connection to pod tracking
    if (!podConnections.has(podId)) {
      podConnections.set(podId, new Set());
    }
    podConnections.get(podId).add(socket);

    // Confirm successful join
    socket.emit("joined-pod", {
      podId,
      userId,
      timestamp: new Date().toISOString(),
    });

    // Notify others in the pod
    socket.to(podId).emit("user-joined", {
      userId,
      timestamp: new Date().toISOString(),
    });

    console.log(`Socket ${socket.id} successfully joined pod ${podId}`);
  });

  // Handle messages
  socket.on("message", (data) => {
    try {
      console.log("Message received:", data);

      if (!socket.podId) {
        socket.emit("error", { message: "Not joined to any pod" });
        return;
      }

      const messageToSend = {
        ...data,
        userId: socket.userId,
        socketId: socket.id,
        timestamp: new Date().toISOString(),
      };

      // Broadcast to all clients in the same pod (including sender)
      io.to(socket.podId).emit("message", messageToSend);

      console.log(`Message broadcasted to pod ${socket.podId}:`, messageToSend);
    } catch (error) {
      console.error("Error processing message:", error);
      socket.emit("error", { message: "Error processing message" });
    }
  });

  // Handle custom events (you can add more as needed)
  socket.on("typing", (data) => {
    if (socket.podId) {
      socket.to(socket.podId).emit("typing", {
        ...data,
        userId: socket.userId,
        timestamp: new Date().toISOString(),
      });
    }
  });

  socket.on("stop-typing", (data) => {
    if (socket.podId) {
      socket.to(socket.podId).emit("stop-typing", {
        ...data,
        userId: socket.userId,
        timestamp: new Date().toISOString(),
      });
    }
  });

  // Handle disconnection
  socket.on("disconnect", (reason) => {
    console.log(`Socket disconnected: ${socket.id} (${reason})`);

    if (socket.podId) {
      // Remove from pod connections
      const podConns = podConnections.get(socket.podId);
      if (podConns) {
        podConns.delete(socket);

        // Clean up empty pod rooms
        if (podConns.size === 0) {
          podConnections.delete(socket.podId);
          console.log(`Cleaned up connections for pod: ${socket.podId}`);
        }
      }

      // Notify others in the pod
      socket.to(socket.podId).emit("user-left", {
        userId: socket.userId,
        timestamp: new Date().toISOString(),
      });
    }
  });

  // Handle errors
  socket.on("error", (error) => {
    console.error(`Socket error for ${socket.id}:`, error);
  });
});

// Helper functions
function getPodConnections(podId) {
  return podConnections.get(podId);
}

function getPodConnectionCount(podId) {
  const connections = podConnections.get(podId);
  return connections ? connections.size : 0;
}

// API endpoints for monitoring
app.get("/api/pods", (req, res) => {
  const podStats = {};
  for (const [podId, connections] of podConnections) {
    podStats[podId] = connections.size;
  }
  res.json({ pods: podStats, totalPods: podConnections.size });
});

app.get("/api/pods/:podId", (req, res) => {
  const { podId } = req.params;
  const count = getPodConnectionCount(podId);
  res.json({ podId, connectionCount: count });
});

// Graceful shutdown
const gracefulShutdown = () => {
  console.log("Shutting down Socket.IO server...");

  io.close(() => {
    console.log("Socket.IO server closed");
    server.close(() => {
      console.log("HTTP server closed");
      process.exit(0);
    });
  });
};

process.on("SIGINT", gracefulShutdown);
process.on("SIGTERM", gracefulShutdown);

// Handle uncaught exceptions
process.on("uncaughtException", (error) => {
  console.error("Uncaught Exception:", error);
  gracefulShutdown();
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
  gracefulShutdown();
});

server.listen(PORT, () => {
  console.log(`Socket.IO server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || "development"}`);
});
