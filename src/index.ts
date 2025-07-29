import WebSocket, { WebSocketServer } from "ws";
import { createServer } from "http";
import { networkInterfaces } from "os";

interface LocationData {
  latitude: number;
  longitude: number;
  accuracy?: number;
  timestamp: number;
}

interface BroadcastLocationData extends LocationData {
  busId: string;
  userId: string;
}

interface ClientMessage {
  type: "location_update" | "subscribe" | "unsubscribe" | "register";
  data?: LocationData;
  busId?: string;
  userId?: string;
  clientType: "bus_driver" | "admin" | "passenger";
  subscribeToBusId?: string;
}

interface ClientInfo {
  id: string;
  type: "bus_driver" | "admin" | "passenger";
  busId?: string;
  userId: string;
  lastLocation?: LocationData;
  connected: boolean;
  subscribedToBusId?: string | undefined;
}

interface ServerMessage {
  type: "location_broadcast" | "connection_ack" | "error" | "client_list";
  data?: BroadcastLocationData;
  message?: string;
  clientCount?: number;
  activeBuses?: string[];
  clients?: ClientInfo[];
}

const server = createServer();
const wss = new WebSocketServer({ server });

const clients = new Map<WebSocket, ClientInfo>();
const busLocations = new Map<string, BroadcastLocationData>();
const busSubscriptions = new Map<string, Set<WebSocket>>();

wss.on("connection", (ws: WebSocket) => {
  console.log("new client connected ");

  const clientInfo: ClientInfo = {
    id: generateClientId(),
    type: "passenger", //default
    userId: "", // will be set on registration
    connected: true,
  };

  clients.set(ws, clientInfo);

  const ackMessage: ServerMessage = {
    type: "connection_ack",
    message: "Connected to GPS tracking server",
    clientCount: clients.size,
  };

  ws.send(JSON.stringify(ackMessage));

  broadcastClientListToSingle(ws);

  ws.on("message", (message: WebSocket.Data) => {
    try {
      const parsedMsg: ClientMessage = JSON.parse(message.toString());
      handleClientMessage(ws, parsedMsg);
    } catch (err) {}
  });

  ws.on("close", () => {
    const clientInfo = clients.get(ws);
    if (clientInfo) {
      console.log(
        `Client ${clientInfo.id} (${clientInfo.userId}) disconnected`
      );

      // Store bus info for potential subscriber notification
      const wasBusDriver = clientInfo.type === "bus_driver" && clientInfo.busId;
      const busId = clientInfo.busId;

      // Clean up subscriptions
      if (clientInfo.subscribedToBusId) {
        const subscribers = busSubscriptions.get(clientInfo.subscribedToBusId);
        if (subscribers) {
          subscribers.delete(ws);
          if (subscribers.size === 0) {
            busSubscriptions.delete(clientInfo.subscribedToBusId);
          }
        }
      }

      // Remove client from clients map
      clients.delete(ws);

      // If this was a bus driver, check if there are other drivers for this bus
      if (wasBusDriver && busId) {
        const otherDrivers = Array.from(clients.values()).filter(
          (client) => client.type === "bus_driver" && client.busId === busId
        );

        if (otherDrivers.length === 0) {
          // No other drivers for this bus, remove location data
          busLocations.delete(busId);
          console.log(
            `Bus ${busId} went offline - no active drivers remaining`
          );

          // Notify subscribers of this specific bus
          const subscribers = busSubscriptions.get(busId);
          if (subscribers && subscribers.size > 0) {
            const offlineMessage: ServerMessage = {
              type: "error",
              message: `Bus ${busId} went offline`,
            };

            const jsonMessage = JSON.stringify(offlineMessage);
            subscribers.forEach((client) => {
              if (client.readyState === WebSocket.OPEN) {
                client.send(jsonMessage);
              }
            });

            // Send updated client list to subscribers of this bus
            const updatedClientList: ClientInfo[] = Array.from(
              clients.values()
            );
            const activeBuses = Array.from(busLocations.keys());

            const clientListMessage: ServerMessage = {
              type: "client_list",
              clients: updatedClientList,
              activeBuses: activeBuses,
              clientCount: clients.size,
            };

            const clientListJson = JSON.stringify(clientListMessage);
            subscribers.forEach((client) => {
              if (client.readyState === WebSocket.OPEN) {
                client.send(clientListJson);
              }
            });

            console.log(
              `Sent updated client list to ${subscribers.size} subscribers of bus ${busId}`
            );
          }
        }
      }

      // Broadcast updated client list to all clients
      broadcastClientList();
    }
  });
});

function handleClientMessage(ws: WebSocket, message: ClientMessage) {
  const clientInfo = clients.get(ws);

  if (!clientInfo) return;

  switch (message.type) {
    case "register":
      if (!message.userId) {
        const errMsg: ServerMessage = {
          type: "error",
          message: "register first with userId",
        };
        ws.send(JSON.stringify(errMsg));
        return;
      }

      // If another connection with this userId exists, ignore this registration
      if (message.userId) {
        for (const [otherWs, otherInfo] of clients.entries()) {
          if (otherWs !== ws && otherInfo.userId === message.userId) {
            // There is already a connection for this userId, so ignore this registration
            const errMsg: ServerMessage = {
              type: "error",
              message:
                "A connection for this userId already exists. Only the first connection is kept.",
            };
            ws.send(JSON.stringify(errMsg));
            return;
          }
        }
      }

      if (message.clientType) {
        if (message.clientType === "bus_driver" && !message.busId) {
          const errMsg: ServerMessage = {
            type: "error",
            message: "bus_driver must register with busId",
          };
          ws.send(JSON.stringify(errMsg));
          return;
        } else if (message.clientType !== "bus_driver" && message.busId) {
          const errMsg: ServerMessage = {
            type: "error",
            message: "clientTypes that are not bus drivers must not have busId",
          };
          ws.send(JSON.stringify(errMsg));
          return;
        }

        clientInfo.type = message.clientType;
        if (message.busId) clientInfo.busId = message.busId;
        clientInfo.userId = message.userId;

        console.log(
          `Client ${clientInfo.userId} (${clientInfo.id}) registered as ${
            clientInfo.type
          }${clientInfo.busId ? ` for bus ${clientInfo.busId}` : ""}`
        );

        broadcastClientList();
        break;
      }

    case "location_update":
      if (!message.userId) {
        const errMsg: ServerMessage = {
          type: "error",
          message: "register first with userId",
        };
        ws.send(JSON.stringify(errMsg));
        return;
      }

      if (
        message.data &&
        (clientInfo.type === "bus_driver" || clientInfo.type === "admin") &&
        clientInfo.busId
      ) {
        const broadcastLocData: BroadcastLocationData = {
          ...message.data,
          busId: clientInfo.busId,
          userId: clientInfo.userId,
        };

        clientInfo.lastLocation = broadcastLocData;
        handleLocationUpdate(broadcastLocData);
      } else if (!clientInfo.busId) {
        const errorMessage: ServerMessage = {
          type: "error",
          message: "Must register with a busId to send location updates",
        };
        ws.send(JSON.stringify(errorMessage));
      } else {
        const errorMessage: ServerMessage = {
          type: "error",
          message: "Only bus drivers and admins can broadcast location updates",
        };
        ws.send(JSON.stringify(errorMessage));
      }
      break;

    case "unsubscribe":
      if (!message.userId) {
        const errMsg: ServerMessage = {
          type: "error",
          message: "register first with userId",
        };
        ws.send(JSON.stringify(errMsg));
        return;
      }

      if (clientInfo.subscribedToBusId) {
        const subscribers = busSubscriptions.get(clientInfo.subscribedToBusId);
        if (subscribers) {
          subscribers.delete(ws);
          if (subscribers.size === 0) {
            busSubscriptions.delete(clientInfo.subscribedToBusId);
          }
        }
        console.log(
          `Client ${clientInfo.id} unsubscribed from bus ${clientInfo.subscribedToBusId}`
        );
        clientInfo.subscribedToBusId = undefined;
      }
      break;

    default:
      const errorMessage: ServerMessage = {
        type: "error",
        message: "Unknown message type",
      };
      ws.send(JSON.stringify(errorMessage));
      break;
  }
}

function handleLocationUpdate(locationData: BroadcastLocationData) {
  const busId = locationData.busId;
  busLocations.set(busId, locationData);

  const subscribedClients = busSubscriptions.get(busId);
  if (subscribedClients && subscribedClients.size > 0) {
    const broadcastMessage: ServerMessage = {
      type: "location_broadcast",
      data: locationData,
    };

    const jsonMessage = JSON.stringify(broadcastMessage);

    subscribedClients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(jsonMessage);
      }
    });

    console.log(
      `Location updated for bus ${busId} - broadcasted to ${subscribedClients.size} subscribers:`,
      {
        lat: locationData.latitude.toFixed(6),
        lng: locationData.longitude.toFixed(6),
        timestamp: new Date(locationData.timestamp).toISOString(),
      }
    );
  } else {
    console.log(`Location updated for bus ${busId} - no subscribers:`, {
      lat: locationData.latitude.toFixed(6),
      lng: locationData.longitude.toFixed(6),
      timestamp: new Date(locationData.timestamp).toISOString(),
    });
  }
}

// Helper functions
function generateClientId(): string {
  return Math.random().toString(36).substr(2, 9);
}

function broadcastClientListToSingle(ws: WebSocket) {
  const clientList: ClientInfo[] = Array.from(clients.values());
  const activeBuses = Array.from(busLocations.keys());

  const msg: ServerMessage = {
    type: "client_list",
    clients: clientList,
    activeBuses: activeBuses,
    clientCount: clients.size,
  };

  ws.send(JSON.stringify(msg));
}

function broadcastClientList() {
  const clientList: ClientInfo[] = Array.from(clients.values());
  const activeBuses = Array.from(busLocations.keys());

  const msg: ServerMessage = {
    type: "client_list",
    clients: clientList,
    activeBuses: activeBuses,
    clientCount: clients.size,
  };

  const jsonMsg = JSON.stringify(msg);

  clients.forEach((_, client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(jsonMsg);
    }
  });
}

const PORT = Number(process.env["PORT"]) || 8080;
const HOST = "0.0.0.0"; // Bind to all interfaces

// Cleanup function to remove dead connections
function cleanupDeadConnections() {
  const deadConnections: WebSocket[] = [];

  clients.forEach((_, ws) => {
    if (
      ws.readyState === WebSocket.CLOSED ||
      ws.readyState === WebSocket.CLOSING
    ) {
      deadConnections.push(ws);
    }
  });

  if (deadConnections.length > 0) {
    console.log(`🧹 Cleaning up ${deadConnections.length} dead connections`);
    deadConnections.forEach((ws) => {
      const clientInfo = clients.get(ws);
      if (clientInfo) {
        console.log(
          `   Removing dead client: ${clientInfo.userId || clientInfo.id}`
        );

        // Clean up subscriptions
        if (clientInfo.subscribedToBusId) {
          const subscribers = busSubscriptions.get(
            clientInfo.subscribedToBusId
          );
          if (subscribers) {
            subscribers.delete(ws);
            if (subscribers.size === 0) {
              busSubscriptions.delete(clientInfo.subscribedToBusId);
            }
          }
        }

        // Remove from clients map
        clients.delete(ws);
      }
    });

    // Broadcast updated client list if any connections were cleaned up
    broadcastClientList();
  }
}

// Run cleanup every 2 minutes
const cleanupInterval = setInterval(cleanupDeadConnections, 120000);

// Heartbeat to detect dead connections
const heartbeatInterval = setInterval(() => {
  clients.forEach((_, ws) => {
    if (ws.readyState === WebSocket.OPEN) {
      // Send ping to keep connection alive and detect dead ones
      ws.ping();
    }
  });
}, 30000); // Every 30 seconds

server.listen(PORT, HOST, () => {
  console.log(`🚀 GPS WebSocket server is running on ${HOST}:${PORT}`);
  console.log(`📱 Local access: ws://localhost:${PORT}`);

  // Display all available network addresses
  const interfaces = networkInterfaces();
  console.log("\n🔗 Connect from React Native using one of these URLs:");

  Object.keys(interfaces).forEach((name) => {
    interfaces[name]?.forEach((net) => {
      if (net.family === "IPv4" && !net.internal) {
        console.log(`   ws://${net.address}:${PORT}`);
      }
    });
  });

  console.log("\n📱 For Android Emulator use: ws://10.0.2.2:8080");
  console.log("📱 For iOS Simulator use: ws://localhost:8080");
  console.log("📱 For Physical Devices use one of the IP addresses above\n");
});

process.on("SIGINT", () => {
  console.log("\n🛑 Shutting down server...");

  // Clear intervals to prevent them from keeping the process alive
  clearInterval(cleanupInterval);
  clearInterval(heartbeatInterval);

  // Notify all connected clients about server shutdown
  const shutdownMessage: ServerMessage = {
    type: "error",
    message: "Server is shutting down",
  };

  const shutdownJson = JSON.stringify(shutdownMessage);

  console.log(`📢 Notifying ${clients.size} connected clients about shutdown`);
  clients.forEach((clientInfo, ws) => {
    if (ws.readyState === WebSocket.OPEN) {
      console.log(
        `   Notifying client ${clientInfo.userId || clientInfo.id} (${
          clientInfo.type
        })`
      );
      ws.send(shutdownJson);

      // Give client time to receive message, then close
      setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.close(1001, "Server shutting down");
        }
      }, 100);
    }
  });

  // Force close WebSocket server after a short delay
  setTimeout(() => {
    console.log("🔌 Closing WebSocket server...");
    wss.close(() => {
      console.log("✅ WebSocket server closed");

      // Close HTTP server
      server.close(() => {
        console.log("✅ HTTP server closed");
        console.log("👋 Server shutdown complete");
        process.exit(0);
      });

      // Force exit if server doesn't close within 5 seconds
      setTimeout(() => {
        console.log(
          "⚠️ Force closing server - some connections may not have closed gracefully"
        );
        process.exit(1);
      }, 5000);
    });
  }, 500);
});

// Handle SIGTERM (for production deployments)
process.on("SIGTERM", () => {
  console.log("\n🛑 Received SIGTERM, shutting down gracefully...");
  process.emit("SIGINT");
});

// Handle uncaught exceptions
process.on("uncaughtException", (error) => {
  console.error("💥 Uncaught Exception:", error);
  process.emit("SIGINT");
});

// Handle unhandled promise rejections
process.on("unhandledRejection", (reason, promise) => {
  console.error("💥 Unhandled Rejection at:", promise, "reason:", reason);
  process.emit("SIGINT");
});
